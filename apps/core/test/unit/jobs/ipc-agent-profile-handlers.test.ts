import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { permissionDecisionResult } from '../channels/permission-approval-result-helpers.js';

import type {
  FileArtifact,
  FileArtifactDescriptor,
  FileArtifactId,
} from '@core/domain/file-artifacts/file-artifact.js';
import type {
  FileArtifactListInput,
  FileArtifactStore,
  FileArtifactWriteInput,
} from '@core/domain/ports/file-artifact-store.js';
import {
  defaultAgentsPromptMarkdown,
  defaultSoulPromptMarkdown,
} from '@core/application/agents/prompt-profile-service.js';

const runtimeHomes: string[] = [];

async function loadProfileHandlers(runtimeHome: string) {
  vi.resetModules();
  vi.stubEnv('GANTRY_HOME', runtimeHome);
  const ipcAuth = await import('@core/runtime/ipc-auth.js');
  const handlers = await import('@core/jobs/ipc-agent-profile-handlers.js');
  return {
    ...handlers,
    taskData: (
      taskId: string,
      payload: Record<string, unknown>,
      appId = 'app:tenant',
    ) => {
      const envelope = ipcAuth.createIpcAuthEnvelope('main_agent');
      return {
        taskId,
        appId,
        chatJid: 'sl:C123',
        jid: 'sl:C123',
        responseKeyId: envelope.responseKeyId,
        payload,
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

function artifactFromInput(
  input: FileArtifactWriteInput & { version?: number; contentHash?: string },
): FileArtifact {
  return {
    id: `file-artifact:${input.appId}:${input.virtualPath}:${input.version ?? 1}` as FileArtifactId,
    appId: input.appId,
    agentId: input.agentId,
    virtualScope: input.virtualScope,
    virtualPath: input.virtualPath,
    version: input.version ?? 1,
    storageType: 'local-filesystem',
    storageRef: 'local/test',
    contentHash:
      input.contentHash ??
      createHash('sha256')
        .update(
          typeof input.content === 'string'
            ? input.content
            : Buffer.from(input.content),
        )
        .digest('hex'),
    sizeBytes:
      typeof input.content === 'string'
        ? Buffer.byteLength(input.content)
        : input.content.byteLength,
    contentType: input.contentType ?? 'text/markdown',
    metadata: input.metadata ?? {},
    createdAt: '2026-06-03T00:00:00.000Z',
    createdBy: input.createdBy,
  };
}

class ProfileStore implements Partial<FileArtifactStore> {
  readonly writes: FileArtifactWriteInput[] = [];
  private current: { artifact: FileArtifact; content: string } | null = null;

  seed(input: {
    appId: string;
    agentId: string;
    virtualScope: string;
    virtualPath: string;
    content: string;
    version: number;
    contentHash: string;
  }): void {
    const artifact = artifactFromInput({
      appId: input.appId,
      agentId: input.agentId,
      virtualScope: input.virtualScope,
      virtualPath: input.virtualPath,
      content: input.content,
      version: input.version,
      contentHash: input.contentHash,
    });
    this.current = { artifact, content: input.content };
  }

  async listFileArtifacts(
    input: FileArtifactListInput,
  ): Promise<FileArtifactDescriptor[]> {
    if (
      !this.current ||
      this.current.artifact.appId !== input.appId ||
      this.current.artifact.agentId !== input.agentId ||
      this.current.artifact.virtualScope !== input.virtualScope ||
      this.current.artifact.virtualPath !== input.virtualPath
    ) {
      return [];
    }
    const artifact = this.current.artifact;
    return [
      {
        id: artifact.id,
        scope: artifact.virtualScope,
        path: artifact.virtualPath,
        version: artifact.version,
        contentHash: artifact.contentHash,
        sizeBytes: artifact.sizeBytes,
        contentType: artifact.contentType,
        createdAt: artifact.createdAt,
      },
    ];
  }

  async readFileArtifact(input: {
    appId: string;
    agentId: string;
    virtualScope?: string;
    virtualPath?: string;
  }): Promise<{
    artifact: FileArtifact;
    content: string;
  }> {
    if (
      !this.current ||
      this.current.artifact.appId !== input.appId ||
      this.current.artifact.agentId !== input.agentId ||
      this.current.artifact.virtualScope !== input.virtualScope ||
      this.current.artifact.virtualPath !== input.virtualPath
    ) {
      throw new Error('not seeded');
    }
    return this.current;
  }

  async writeFileArtifact(
    input: FileArtifactWriteInput,
  ): Promise<FileArtifact> {
    this.writes.push(input);
    const version = (this.current?.artifact.version ?? 0) + 1;
    const artifact = artifactFromInput({ ...input, version });
    this.current = {
      artifact,
      content:
        typeof input.content === 'string'
          ? input.content
          : Buffer.from(input.content).toString('utf-8'),
    };
    return artifact;
  }
}

function contextFor(input: {
  data: Record<string, unknown>;
  store: ProfileStore;
  requestPermissionApproval?: ReturnType<typeof vi.fn>;
  sendMessage?: ReturnType<typeof vi.fn>;
}) {
  return {
    data: input.data,
    sourceAgentFolder: 'main_agent',
    deps: {
      getFileArtifactStore: () => input.store,
      requestPermissionApproval:
        input.requestPermissionApproval ??
        vi.fn(async () =>
          permissionDecisionResult({
            approved: true,
            decidedBy: 'user:approver',
          }),
        ),
      sendMessage: input.sendMessage ?? vi.fn(),
      publishRuntimeEvent: vi.fn(),
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

describe('agent profile IPC handlers', () => {
  it('rejects profile updates that do not include expectedVersion', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-profile-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { agentProfileTaskHandlers, taskData } =
      await loadProfileHandlers(runtimeHome);
    const store = new ProfileStore();
    const requestPermissionApproval = vi.fn();

    await agentProfileTaskHandlers.request_agent_profile_update(
      contextFor({
        store,
        requestPermissionApproval,
        data: taskData('missing-version', {
          file: 'agents',
          content: '# next',
          summary: 'Update agent instructions.',
        }),
      }),
    );

    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(readResponse(runtimeHome, 'missing-version')).toMatchObject({
      ok: false,
      code: 'invalid_request',
      error:
        'Read the profile file first with agent_profile_read and pass expectedVersion.',
    });
  });

  it('rejects profile updates too large to fully render for approval', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-profile-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { agentProfileTaskHandlers, taskData } =
      await loadProfileHandlers(runtimeHome);
    const store = new ProfileStore();
    const requestPermissionApproval = vi.fn();

    await agentProfileTaskHandlers.request_agent_profile_update(
      contextFor({
        store,
        requestPermissionApproval,
        data: taskData('large-update', {
          file: 'agents',
          content: `# next\n${'x'.repeat(4000)}`,
          summary: 'Update agent instructions.',
          expectedVersion: 0,
        }),
      }),
    );

    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(readResponse(runtimeHome, 'large-update')).toMatchObject({
      ok: false,
      code: 'invalid_request',
      error: expect.stringContaining('too large to review safely in chat'),
    });
  });

  it('rejects profile updates whose approval evidence would be redacted', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-profile-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { agentProfileTaskHandlers, taskData } =
      await loadProfileHandlers(runtimeHome);
    const store = new ProfileStore();
    const requestPermissionApproval = vi.fn();

    await agentProfileTaskHandlers.request_agent_profile_update(
      contextFor({
        store,
        requestPermissionApproval,
        data: taskData('redacted-update', {
          file: 'agents',
          content: `# next\napi_key: sk-${'a'.repeat(24)}`,
          summary: 'Update agent instructions.',
          expectedVersion: 0,
        }),
      }),
    );

    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(readResponse(runtimeHome, 'redacted-update')).toMatchObject({
      ok: false,
      code: 'invalid_request',
      error: expect.stringContaining('cannot be fully shown for approval'),
    });
  });

  it.each([
    ['agents', defaultAgentsPromptMarkdown('Default Agent', 'personal')],
    ['soul', defaultSoulPromptMarkdown('Default Agent', 'personal')],
  ])(
    'allows the default seeded %s profile size through approval',
    async (file, content) => {
      const runtimeHome = fs.mkdtempSync(
        path.join(os.tmpdir(), 'gantry-profile-ipc-'),
      );
      runtimeHomes.push(runtimeHome);
      const { agentProfileTaskHandlers, taskData } =
        await loadProfileHandlers(runtimeHome);
      const store = new ProfileStore();
      store.seed({
        appId: 'app:tenant',
        agentId: 'agent:main_agent',
        virtualScope: 'prompt-profile',
        virtualPath: `main_agent/${file === 'agents' ? 'AGENTS.md' : 'SOUL.md'}`,
        content: '# current',
        version: 0,
        contentHash: 'hash-current',
      });
      const requestPermissionApproval = vi.fn(async () =>
        permissionDecisionResult({
          approved: false,
          reason: 'stop after approval request',
        }),
      );

      await agentProfileTaskHandlers.request_agent_profile_update(
        contextFor({
          store,
          requestPermissionApproval,
          data: taskData(`default-${file}`, {
            file,
            content,
            summary: 'Default profile sized update.',
            expectedVersion: 0,
          }),
        }),
      );

      expect(requestPermissionApproval).toHaveBeenCalled();
    },
  );

  it('uses the task app id and sends full proposed content evidence for approval', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-profile-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { agentProfileTaskHandlers, taskData } =
      await loadProfileHandlers(runtimeHome);
    const store = new ProfileStore();
    store.seed({
      appId: 'app:tenant',
      agentId: 'agent:main_agent',
      virtualScope: 'prompt-profile',
      virtualPath: 'main_agent/AGENTS.md',
      content: '# current',
      version: 3,
      contentHash: 'hash-current',
    });
    const proposedContent = '# next\n\nUse memory_search before guessing.';
    const requestPermissionApproval = vi.fn(async () =>
      permissionDecisionResult({
        approved: true,
        decidedBy: 'user:approver',
      }),
    );

    await agentProfileTaskHandlers.request_agent_profile_update(
      contextFor({
        store,
        requestPermissionApproval,
        data: taskData('approve-update', {
          file: 'agents',
          content: proposedContent,
          summary: 'Clarify memory behavior.',
          expectedVersion: 3,
        }),
      }),
    );

    expect(requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:tenant',
        toolInput: expect.objectContaining({
          expectedVersion: 3,
          proposedContent,
          proposedContentBytes: Buffer.byteLength(proposedContent, 'utf8'),
          proposedContentHash: createHash('sha256')
            .update(proposedContent, 'utf8')
            .digest('hex'),
          proposedContentEvidence: 'interaction.files[0].preview',
        }),
        interaction: expect.objectContaining({
          files: [
            expect.objectContaining({
              path: 'AGENTS.md',
              preview: proposedContent,
              truncated: false,
            }),
          ],
        }),
      }),
    );
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]).toMatchObject({
      appId: 'app:tenant',
      agentId: 'agent:main_agent',
      virtualScope: 'prompt-profile',
      virtualPath: 'main_agent/AGENTS.md',
      content: proposedContent,
    });
    expect(readResponse(runtimeHome, 'approve-update')).toMatchObject({
      ok: true,
      data: expect.objectContaining({ file: 'agents', version: 4 }),
    });
  });
});
