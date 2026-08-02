import { describe, expect, it, vi } from 'vitest';

import {
  AgentProfileService,
  MAX_PROFILE_CONTENT_BYTES,
  ProfileContentTooLargeError,
  ProfileVersionConflictError,
} from '@core/application/agents/agent-profile-service.js';
import {
  FileArtifactNotFoundError,
  type FileArtifact,
  type FileArtifactDescriptor,
  type FileArtifactId,
} from '@core/domain/file-artifacts/file-artifact.js';
import type {
  FileArtifactListInput,
  FileArtifactStore,
  FileArtifactWriteInput,
} from '@core/domain/ports/file-artifact-store.js';

class MemoryStore implements FileArtifactStore {
  private seq = 0;
  private readonly versions = new Map<string, FileArtifact[]>();
  private readonly contents = new Map<FileArtifactId, string | Uint8Array>();

  private key(input: {
    appId: string;
    agentId: string;
    virtualScope: string;
    virtualPath: string;
  }): string {
    return [
      input.appId,
      input.agentId,
      input.virtualScope,
      input.virtualPath,
    ].join(':');
  }

  async writeFileArtifact(
    input: FileArtifactWriteInput,
  ): Promise<FileArtifact> {
    const key = this.key(input);
    const list = this.versions.get(key) ?? [];
    const version = (list[0]?.version ?? 0) + 1;
    const id = `fa:${++this.seq}` as FileArtifactId;
    const artifact: FileArtifact = {
      id,
      appId: input.appId,
      agentId: input.agentId,
      virtualScope: input.virtualScope,
      virtualPath: input.virtualPath,
      version,
      storageType: 'local-filesystem',
      storageRef: `memory://${id}`,
      contentHash: `hash-${this.seq}`,
      sizeBytes:
        typeof input.content === 'string'
          ? Buffer.byteLength(input.content)
          : input.content.byteLength,
      contentType: input.contentType ?? 'text/markdown',
      metadata: input.metadata ?? {},
      createdAt: new Date(this.seq * 1000).toISOString(),
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    };
    this.versions.set(key, [artifact, ...list]);
    this.contents.set(id, input.content);
    return artifact;
  }

  async readFileArtifact(input: {
    appId: string;
    agentId: string;
    virtualScope?: string;
    virtualPath?: string;
    version?: number;
  }): Promise<{ artifact: FileArtifact; content: Uint8Array | string }> {
    const list =
      this.versions.get(
        this.key({
          appId: input.appId,
          agentId: input.agentId,
          virtualScope: input.virtualScope ?? '',
          virtualPath: input.virtualPath ?? '',
        }),
      ) ?? [];
    const artifact = input.version
      ? list.find((entry) => entry.version === input.version)
      : list[0];
    if (!artifact) throw new FileArtifactNotFoundError();
    const content = this.contents.get(artifact.id);
    if (content === undefined) throw new FileArtifactNotFoundError();
    return { artifact, content };
  }

  async listFileArtifacts(
    input: FileArtifactListInput,
  ): Promise<FileArtifactDescriptor[]> {
    const list =
      this.versions.get(
        this.key({
          appId: input.appId,
          agentId: input.agentId,
          virtualScope: input.virtualScope ?? '',
          virtualPath: input.virtualPath ?? '',
        }),
      ) ?? [];
    return list.slice(0, input.limit ?? list.length).map((artifact) => ({
      id: artifact.id,
      scope: artifact.virtualScope,
      path: artifact.virtualPath,
      version: artifact.version,
      contentHash: artifact.contentHash,
      sizeBytes: artifact.sizeBytes,
      contentType: artifact.contentType,
      createdAt: artifact.createdAt,
    }));
  }

  async promoteScratch(): Promise<FileArtifact> {
    throw new Error('not used');
  }
}

describe('AgentProfileService', () => {
  it('writes a new version, mirrors content, and audits the update', async () => {
    const store = new MemoryStore();
    const mirror = vi.fn();
    const audit = vi.fn();
    const service = new AgentProfileService({
      fileArtifactStore: () => store,
      mirrorProfileFile: mirror,
      audit,
    });

    const first = await service.writeProfileFile({
      agentFolder: 'team',
      kind: 'agents',
      content: '# v1',
      actor: 'control',
      approvalSource: 'control_api',
    });
    expect(first.version).toBe(1);
    expect(mirror).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: 'AGENTS.md',
        content: '# v1',
        version: 1,
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'update', kind: 'agents', version: 1 }),
    );

    const read = await service.readProfileFile('team', 'agents');
    expect(read.content).toBe('# v1');
    expect(read.version).toBe(1);
  });

  it('does not report a committed profile write as failed when side effects fail', async () => {
    const store = new MemoryStore();
    const mirror = vi.fn(async () => {
      throw new Error('mirror unavailable');
    });
    const audit = vi.fn(async () => {
      throw new Error('audit unavailable');
    });
    const onSideEffectError = vi.fn();
    const service = new AgentProfileService({
      fileArtifactStore: () => store,
      mirrorProfileFile: mirror,
      audit,
      onSideEffectError,
    });

    const result = await service.writeProfileFile({
      agentFolder: 'team',
      kind: 'agents',
      content: '# durable',
      actor: 'control',
    });

    expect(result.version).toBe(1);
    expect(onSideEffectError).toHaveBeenCalledWith(
      expect.objectContaining({ sideEffect: 'mirror', version: 1 }),
    );
    expect(onSideEffectError).toHaveBeenCalledWith(
      expect.objectContaining({ sideEffect: 'audit', version: 1 }),
    );
    const read = await new AgentProfileService({
      fileArtifactStore: () => store,
    }).readProfileFile('team', 'agents');
    expect(read.content).toBe('# durable');
  });

  it('does not report a committed profile read as failed when audit fails', async () => {
    const store = new MemoryStore();
    await new AgentProfileService({
      fileArtifactStore: () => store,
    }).writeProfileFile({
      agentFolder: 'team',
      kind: 'agents',
      content: '# durable',
      actor: 'control',
    });
    const audit = vi.fn(async () => {
      throw new Error('audit unavailable');
    });
    const onSideEffectError = vi.fn();
    const service = new AgentProfileService({
      fileArtifactStore: () => store,
      audit,
      onSideEffectError,
    });

    const read = await service.readProfileFile('team', 'agents', {
      actor: 'agent',
    });

    expect(read.content).toBe('# durable');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'read', actor: 'agent', version: 1 }),
    );
    expect(onSideEffectError).toHaveBeenCalledWith(
      expect.objectContaining({ sideEffect: 'audit', version: 1 }),
    );
  });

  it('enforces optimistic concurrency with expectedVersion', async () => {
    const store = new MemoryStore();
    const service = new AgentProfileService({
      fileArtifactStore: () => store,
    });
    await service.writeProfileFile({
      agentFolder: 'team',
      kind: 'soul',
      content: 'a',
      actor: 'control',
    });

    await expect(
      service.writeProfileFile({
        agentFolder: 'team',
        kind: 'soul',
        content: 'b',
        expectedVersion: 0,
        actor: 'control',
      }),
    ).rejects.toBeInstanceOf(ProfileVersionConflictError);

    // Correct expectedVersion succeeds and bumps the version.
    const next = await service.writeProfileFile({
      agentFolder: 'team',
      kind: 'soul',
      content: 'b',
      expectedVersion: 1,
      actor: 'control',
    });
    expect(next.version).toBe(2);
  });

  it('rejects content that exceeds the size cap before writing', async () => {
    const store = new MemoryStore();
    const writeSpy = vi.spyOn(store, 'writeFileArtifact');
    const service = new AgentProfileService({
      fileArtifactStore: () => store,
    });

    await expect(
      service.writeProfileFile({
        agentFolder: 'team',
        kind: 'soul',
        content: 'x'.repeat(MAX_PROFILE_CONTENT_BYTES + 1),
        actor: 'control',
      }),
    ).rejects.toBeInstanceOf(ProfileContentTooLargeError);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('lists both profile kinds including not-yet-seeded files', async () => {
    const store = new MemoryStore();
    const service = new AgentProfileService({
      fileArtifactStore: () => store,
    });
    await service.writeProfileFile({
      agentFolder: 'team',
      kind: 'agents',
      content: 'x',
      actor: 'control',
    });

    const files = await service.listProfileFiles('team');
    const byKind = Object.fromEntries(files.map((f) => [f.kind, f]));
    expect(byKind.agents?.version).toBe(1);
    expect(byKind.agents?.path).toBe('AGENTS.md');
    expect(byKind.soul?.version).toBe(0);
    expect(byKind.soul?.path).toBe('SOUL.md');
  });

  it('keeps same-folder profile files isolated by app id', async () => {
    const store = new MemoryStore();
    const appA = new AgentProfileService({
      appId: 'app-a',
      fileArtifactStore: () => store,
    });
    const appB = new AgentProfileService({
      appId: 'app-b',
      fileArtifactStore: () => store,
    });

    await appA.writeProfileFile({
      agentFolder: 'team',
      kind: 'agents',
      content: '# app a',
      actor: 'control',
    });
    await appB.writeProfileFile({
      agentFolder: 'team',
      kind: 'agents',
      content: '# app b',
      actor: 'control',
    });

    await expect(appA.readProfileFile('team', 'agents')).resolves.toMatchObject(
      {
        content: '# app a',
        version: 1,
      },
    );
    await expect(appB.readProfileFile('team', 'agents')).resolves.toMatchObject(
      {
        content: '# app b',
        version: 1,
      },
    );

    const [filesA, filesB] = await Promise.all([
      appA.listProfileFiles('team'),
      appB.listProfileFiles('team'),
    ]);
    expect(filesA.find((file) => file.kind === 'agents')?.contentHash).not.toBe(
      filesB.find((file) => file.kind === 'agents')?.contentHash,
    );
  });
});
