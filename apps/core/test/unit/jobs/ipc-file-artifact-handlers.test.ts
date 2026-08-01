import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileArtifact } from '@core/domain/file-artifacts/file-artifact.js';
import { appendLiveToolRules } from '@core/shared/live-tool-rules.js';

const runtimeHomes: string[] = [];

async function loadFileArtifactHandlers(runtimeHome: string) {
  vi.resetModules();
  vi.stubEnv('GANTRY_HOME', runtimeHome);
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
  readFileArtifact?: ReturnType<typeof vi.fn>;
}) {
  return {
    data: input.data,
    sourceAgentFolder: 'main_agent',
    ipcBaseDir: input.ipcBaseDir,
    deps: {
      getFileArtifactStore: () => ({
        readFileArtifact: input.readFileArtifact,
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
      path.join(os.tmpdir(), 'gantry-file-ipc-'),
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

  it('reads workspace message attachments through the file tool path', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-file-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { fileArtifactTaskHandlers, taskData } =
      await loadFileArtifactHandlers(runtimeHome);
    const attachmentDir = path.join(
      runtimeHome,
      'agents',
      'main_agent',
      'attachments',
    );
    fs.mkdirSync(attachmentDir, { recursive: true });
    fs.writeFileSync(
      path.join(attachmentDir, 'skills.md'),
      '# ATS Skills\nRead this file.',
      { mode: 0o600 },
    );
    const writeFileArtifact = vi.fn();

    await fileArtifactTaskHandlers.file_artifact(
      contextFor({
        data: taskData('read-workspace-attachment', {
          payload: {
            action: 'read',
            path: 'attachments/skills.md',
          },
        }),
        writeFileArtifact,
      }),
    );

    expect(writeFileArtifact).not.toHaveBeenCalled();
    expect(
      readResponse(runtimeHome, 'read-workspace-attachment'),
    ).toMatchObject({
      ok: true,
      data: {
        ok: true,
        attachment: {
          filename: 'skills.md',
          contentType: 'text/markdown',
        },
        content: {
          encoding: 'utf8',
          text: '# ATS Skills\nRead this file.',
        },
      },
    });
  });

  it('does not shadow scoped FileArtifact reads under attachments paths', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-file-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { fileArtifactTaskHandlers, taskData } =
      await loadFileArtifactHandlers(runtimeHome);
    const writeFileArtifact = vi.fn();
    const readFileArtifact = vi.fn(async () => ({
      artifact: makeArtifact({
        virtualScope: 'default',
        virtualPath: 'attachments/skills.md',
        content: 'from artifact store',
      }),
      content: 'from artifact store',
    }));

    await fileArtifactTaskHandlers.file_artifact(
      contextFor({
        data: taskData('read-scoped-attachment-artifact', {
          payload: {
            action: 'read',
            scope: 'default',
            path: 'attachments/skills.md',
          },
        }),
        readFileArtifact,
        writeFileArtifact,
      }),
    );

    expect(readFileArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        virtualScope: 'default',
        virtualPath: 'attachments/skills.md',
      }),
    );
    expect(
      readResponse(runtimeHome, 'read-scoped-attachment-artifact'),
    ).toMatchObject({
      ok: true,
      data: {
        ok: true,
        content: {
          encoding: 'utf8',
          text: 'from artifact store',
        },
      },
    });
  });

  it('accepts protected prompt writes approved for the current run', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-file-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { fileArtifactTaskHandlers, taskData } =
      await loadFileArtifactHandlers(runtimeHome);
    const ipcBaseDir = path.join(runtimeHome, 'data', 'ipc');
    appendLiveToolRules({
      ipcDir: path.join(ipcBaseDir, 'main_agent'),
      runHandle: 'run_live_1',
      rules: ['mcp__gantry__request_settings_update'],
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
            path: 'agents/main_agent/settings.yaml',
            content: 'runtime config\n',
          },
        }),
        writeFileArtifact,
      }),
    );

    expect(writeFileArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        virtualPath: 'agents/main_agent/settings.yaml',
        content: 'runtime config\n',
      }),
    );
    expect(readResponse(runtimeHome, 'write-protected-live')).toMatchObject({
      ok: true,
    });
  });

  it('rejects protected prompt writes without admin capability', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-file-ipc-'),
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
            path: 'agents/main_agent/settings.yaml',
            content: 'runtime config\n',
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

  it('rejects profile artifact writes in the prompt-profile scope and points to request_agent_profile_update', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-file-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { fileArtifactTaskHandlers, taskData } =
      await loadFileArtifactHandlers(runtimeHome);
    const ipcBaseDir = path.join(runtimeHome, 'data', 'ipc');
    // Even with admin capability + protected=true, profile artifacts are
    // off-limits to the generic file tool.
    appendLiveToolRules({
      ipcDir: path.join(ipcBaseDir, 'main_agent'),
      runHandle: 'run_live_profile',
      rules: ['mcp__gantry__request_settings_update'],
    });
    const writeFileArtifact = vi.fn();

    for (const fileName of ['AGENTS.md', 'SOUL.md']) {
      await fileArtifactTaskHandlers.file_artifact(
        contextFor({
          ipcBaseDir,
          data: taskData(`write-profile-${fileName}`, {
            runHandle: 'run_live_profile',
            payload: {
              action: 'write',
              protected: true,
              scope: 'prompt-profile',
              path: `main_agent/${fileName}`,
              content: 'tampered\n',
            },
          }),
          writeFileArtifact,
        }),
      );
      const response = readResponse(runtimeHome, `write-profile-${fileName}`);
      expect(response).toMatchObject({ ok: false, code: 'forbidden' });
      expect(String(response.error)).toContain('request_agent_profile_update');
    }
    expect(writeFileArtifact).not.toHaveBeenCalled();
  });

  it('allows ordinary artifacts that merely share a profile filename in another scope', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-file-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { fileArtifactTaskHandlers, taskData } =
      await loadFileArtifactHandlers(runtimeHome);
    const writeFileArtifact = vi.fn(async (input) =>
      makeArtifact({
        virtualScope: input.virtualScope,
        virtualPath: input.virtualPath,
        content: input.content,
      }),
    );

    await fileArtifactTaskHandlers.file_artifact(
      contextFor({
        data: taskData('write-docs-agents', {
          payload: {
            action: 'write',
            scope: 'default',
            path: 'docs/AGENTS.md',
            content: 'project notes\n',
          },
        }),
        writeFileArtifact,
      }),
    );

    expect(writeFileArtifact).toHaveBeenCalledTimes(1);
    expect(readResponse(runtimeHome, 'write-docs-agents')).toMatchObject({
      ok: true,
      data: {
        ok: true,
        artifact: { scope: 'default', path: 'docs/AGENTS.md' },
      },
    });
  });
});
