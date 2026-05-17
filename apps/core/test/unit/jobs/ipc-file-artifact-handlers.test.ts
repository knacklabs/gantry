import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileArtifact } from '@core/domain/file-artifacts/file-artifact.js';
import { appendLiveToolRules } from '@core/shared/live-tool-rules.js';

const runtimeHomes: string[] = [];

async function loadFileArtifactHandlers(runtimeHome: string) {
  vi.resetModules();
  vi.stubEnv('MYCLAW_HOME', runtimeHome);
  const ipcAuth = await import('@core/runtime/ipc-auth.js');
  const handlers = await import('@core/jobs/ipc-file-artifact-handlers.js');
  return {
    ...handlers,
    taskData: (
      taskId: string,
      extra: Record<string, unknown> = {},
      threadId?: string,
    ) => {
      const envelope = ipcAuth.createIpcAuthEnvelope('main_agent', threadId);
      return {
        taskId,
        appId: 'app:test',
        chatJid: 'sl:C123',
        jid: 'sl:C123',
        ...(threadId ? { authThreadId: threadId } : {}),
        responseKeyId: envelope.responseKeyId,
        ...extra,
      };
    },
  };
}

function readResponse(runtimeHome: string, taskId: string) {
  return JSON.parse(
    fs.readFileSync(
      path.join(
        runtimeHome,
        'data',
        'ipc',
        'main_agent',
        'task-responses',
        `task-${taskId}.json`,
      ),
      'utf-8',
    ),
  );
}

function makeArtifact(input: {
  virtualScope: string;
  virtualPath: string;
  content: Uint8Array | string;
  version?: number;
}): FileArtifact {
  return {
    id: `file-artifact:${input.virtualPath}:${input.version ?? 1}` as never,
    appId: 'app:test',
    agentId: 'agent:main_agent',
    virtualScope: input.virtualScope,
    virtualPath: input.virtualPath,
    version: input.version ?? 1,
    storageType: 'local-filesystem',
    storageRef: 'local/test',
    contentHash: 'sha256:test',
    sizeBytes:
      typeof input.content === 'string'
        ? Buffer.byteLength(input.content)
        : input.content.byteLength,
    contentType: 'text/plain; charset=utf-8',
    metadata: {},
    createdAt: '2026-05-14T00:00:00.000Z',
    createdBy: 'agent:main_agent',
  };
}

function contextFor(input: {
  data: Record<string, unknown>;
  ipcBaseDir?: string;
  writeFileArtifact: ReturnType<typeof vi.fn>;
}) {
  return {
    data: input.data,
    sourceAgentFolder: 'main_agent',
    ipcBaseDir: input.ipcBaseDir,
    deps: {
      getFileArtifactStore: () => ({
        writeFileArtifact: input.writeFileArtifact,
      }),
      getToolRepository: () => ({
        listAgentToolBindings: async () => [],
        getTool: async () => undefined,
      }),
    },
    conversationBindings: {},
    sourceAgentFolderJids: ['sl:C123'],
  } as never;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('file artifact IPC handlers', () => {
  it('preserves explicit write content through the signed IPC response path', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-file-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { fileArtifactTaskHandlers, taskData } =
      await loadFileArtifactHandlers(runtimeHome);
    const content = '  keep leading space\nkeep trailing space  \n\n';
    const writeFileArtifact = vi.fn(async (input) =>
      makeArtifact({
        virtualScope: input.virtualScope,
        virtualPath: input.virtualPath,
        content: input.content,
      }),
    );

    await fileArtifactTaskHandlers.file_artifact(
      contextFor({
        data: taskData('write-preserve', {
          payload: {
            action: 'write',
            scope: 'default',
            path: 'notes/result.txt',
            content,
          },
        }),
        writeFileArtifact,
      }),
    );

    expect(writeFileArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ content }),
    );
    expect(readResponse(runtimeHome, 'write-preserve')).toMatchObject({
      ok: true,
      data: {
        ok: true,
        artifact: {
          scope: 'default',
          path: 'notes/result.txt',
          version: 1,
        },
      },
    });
  });

  it('accepts protected prompt writes approved for the current run', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-file-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { fileArtifactTaskHandlers, taskData } =
      await loadFileArtifactHandlers(runtimeHome);
    const ipcBaseDir = path.join(runtimeHome, 'data', 'ipc');
    appendLiveToolRules({
      ipcDir: path.join(ipcBaseDir, 'main_agent'),
      runHandle: 'run_live_1',
      rules: ['mcp__myclaw__request_settings_update'],
    });
    const writeFileArtifact = vi.fn(async (input) =>
      makeArtifact({
        virtualScope: input.virtualScope,
        virtualPath: input.virtualPath,
        content: input.content,
      }),
    );

    await fileArtifactTaskHandlers.file_artifact(
      contextFor({
        ipcBaseDir,
        data: taskData('write-protected-live', {
          runHandle: 'run_live_1',
          payload: {
            action: 'write',
            protected: true,
            scope: 'prompt',
            path: 'agents/main_agent/CLAUDE.md',
            content: 'runtime prompt\n',
          },
        }),
        writeFileArtifact,
      }),
    );

    expect(writeFileArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        virtualPath: 'agents/main_agent/CLAUDE.md',
        content: 'runtime prompt\n',
      }),
    );
    expect(readResponse(runtimeHome, 'write-protected-live')).toMatchObject({
      ok: true,
    });
  });

  it('rejects protected prompt writes without admin capability', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-file-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { fileArtifactTaskHandlers, taskData } =
      await loadFileArtifactHandlers(runtimeHome);
    const writeFileArtifact = vi.fn();

    await fileArtifactTaskHandlers.file_artifact(
      contextFor({
        data: taskData('write-protected-denied', {
          payload: {
            action: 'write',
            protected: true,
            scope: 'prompt',
            path: 'agents/main_agent/CLAUDE.md',
            content: 'runtime prompt\n',
          },
        }),
        writeFileArtifact,
      }),
    );

    expect(writeFileArtifact).not.toHaveBeenCalled();
    expect(readResponse(runtimeHome, 'write-protected-denied')).toMatchObject({
      ok: false,
      code: 'missing_capability',
    });
  });
});
