import {
  FileArtifactNotFoundError,
  FileArtifactVersionConflictError,
  type FileArtifactDescriptor,
} from '../../domain/file-artifacts/file-artifact.js';
import type { FileArtifactStore } from '../../domain/ports/file-artifact-store.js';
import {
  PROFILE_FILE_NAMES,
  PROMPT_PROFILE_VIRTUAL_SCOPE,
  promptProfileAgentIdForFolder,
  promptProfileAgentsPath,
  promptProfileSoulPath,
  type ProfileMirrorInput,
} from './prompt-profile-service.js';

export const PROFILE_FILE_KINDS = ['soul', 'agents'] as const;
export type ProfileFileKind = (typeof PROFILE_FILE_KINDS)[number];

const DEFAULT_PROFILE_APP_ID = 'default';

// Upper bound on profile content, matching the generic file-tool write cap.
// Profile writes bypass that path, so the bound is enforced here at the shared
// write choke point (covers both the control API and the IPC tool).
export const MAX_PROFILE_CONTENT_BYTES = 2_000_000;

export class ProfileContentTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(
      `Profile content exceeds the ${maxBytes}-byte limit. Shorten it and retry.`,
    );
    this.name = 'ProfileContentTooLargeError';
  }
}

export function isProfileFileKind(value: unknown): value is ProfileFileKind {
  return (
    typeof value === 'string' &&
    (PROFILE_FILE_KINDS as readonly string[]).includes(value)
  );
}

export class ProfileVersionConflictError extends Error {
  constructor(public readonly latestVersion: number) {
    super(
      'Profile file changed since you last read it. Refresh the latest version and retry.',
    );
    this.name = 'ProfileVersionConflictError';
  }
}

export interface ProfileFileSummary {
  kind: ProfileFileKind;
  path: string;
  version: number;
  contentHash: string;
  sizeBytes: number;
  updatedAt: string | null;
}

export interface ProfileFileContent {
  kind: ProfileFileKind;
  path: string;
  version: number;
  contentHash: string;
  content: string;
}

export interface ProfileAuditInput {
  action: 'read' | 'update';
  agentFolder: string;
  kind: ProfileFileKind;
  version: number;
  contentHash: string;
  actor: string;
  approvalSource?: string;
}

export interface AgentProfileServiceOptions {
  fileArtifactStore: () => FileArtifactStore | undefined;
  appId?: string;
  mirrorProfileFile?: (input: ProfileMirrorInput) => void | Promise<void>;
  audit?: (input: ProfileAuditInput) => void | Promise<void>;
  onSideEffectError?: (input: {
    sideEffect: 'mirror' | 'audit';
    error: unknown;
    agentFolder: string;
    kind: ProfileFileKind;
    version: number;
  }) => void | Promise<void>;
}

function profileVirtualPath(
  kind: ProfileFileKind,
  agentFolder: string,
): string {
  return kind === 'soul'
    ? promptProfileSoulPath(agentFolder)
    : promptProfileAgentsPath(agentFolder);
}

export class AgentProfileService {
  private readonly fileArtifactStore: () => FileArtifactStore | undefined;
  private readonly appId: string;
  private readonly mirrorProfileFile?: (
    input: ProfileMirrorInput,
  ) => void | Promise<void>;
  private readonly audit?: (input: ProfileAuditInput) => void | Promise<void>;
  private readonly onSideEffectError?: AgentProfileServiceOptions['onSideEffectError'];

  constructor(options: AgentProfileServiceOptions) {
    this.fileArtifactStore = options.fileArtifactStore;
    this.appId = options.appId || DEFAULT_PROFILE_APP_ID;
    this.mirrorProfileFile = options.mirrorProfileFile;
    this.audit = options.audit;
    this.onSideEffectError = options.onSideEffectError;
  }

  private requireStore(): FileArtifactStore {
    const store = this.fileArtifactStore();
    if (!store) throw new Error('FileArtifact storage is not ready.');
    return store;
  }

  private async latestDescriptor(
    agentFolder: string,
    kind: ProfileFileKind,
  ): Promise<FileArtifactDescriptor | null> {
    const store = this.requireStore();
    const existing = await store.listFileArtifacts({
      appId: this.appId,
      agentId: promptProfileAgentIdForFolder(agentFolder),
      virtualScope: PROMPT_PROFILE_VIRTUAL_SCOPE,
      virtualPath: profileVirtualPath(kind, agentFolder),
      limit: 1,
    });
    return existing[0] ?? null;
  }

  async listProfileFiles(agentFolder: string): Promise<ProfileFileSummary[]> {
    const summaries: ProfileFileSummary[] = [];
    for (const kind of PROFILE_FILE_KINDS) {
      const latest = await this.latestDescriptor(agentFolder, kind);
      summaries.push({
        kind,
        path: PROFILE_FILE_NAMES[kind],
        version: latest?.version ?? 0,
        contentHash: latest?.contentHash ?? '',
        sizeBytes: latest?.sizeBytes ?? 0,
        updatedAt: latest?.createdAt ?? null,
      });
    }
    return summaries;
  }

  async readProfileFile(
    agentFolder: string,
    kind: ProfileFileKind,
    options: { actor?: string } = {},
  ): Promise<ProfileFileContent> {
    const store = this.requireStore();
    const result = await store.readFileArtifact({
      appId: this.appId,
      agentId: promptProfileAgentIdForFolder(agentFolder),
      virtualScope: PROMPT_PROFILE_VIRTUAL_SCOPE,
      virtualPath: profileVirtualPath(kind, agentFolder),
    });
    const content =
      typeof result.content === 'string'
        ? result.content
        : Buffer.from(result.content).toString('utf-8');
    if (this.audit) {
      try {
        await this.audit({
          action: 'read',
          agentFolder,
          kind,
          version: result.artifact.version,
          contentHash: result.artifact.contentHash,
          actor: options.actor ?? 'system',
        });
      } catch (error) {
        await this.reportSideEffectError({
          sideEffect: 'audit',
          error,
          agentFolder,
          kind,
          version: result.artifact.version,
        });
      }
    }
    return {
      kind,
      path: PROFILE_FILE_NAMES[kind],
      version: result.artifact.version,
      contentHash: result.artifact.contentHash,
      content,
    };
  }

  async writeProfileFile(input: {
    agentFolder: string;
    kind: ProfileFileKind;
    content: string;
    expectedVersion?: number;
    actor: string;
    approvalSource?: string;
    createdBy?: string;
  }): Promise<{ version: number; contentHash: string }> {
    if (Buffer.byteLength(input.content, 'utf-8') > MAX_PROFILE_CONTENT_BYTES) {
      throw new ProfileContentTooLargeError(MAX_PROFILE_CONTENT_BYTES);
    }
    const store = this.requireStore();
    const latest = await this.latestDescriptor(input.agentFolder, input.kind);
    const latestVersion = latest?.version ?? 0;
    // Fast-fail on a stale read; the store re-checks expectedVersion atomically
    // under its version-path lock to also catch concurrent same-version writers.
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== latestVersion
    ) {
      throw new ProfileVersionConflictError(latestVersion);
    }
    let artifact;
    try {
      artifact = await store.writeFileArtifact({
        appId: this.appId,
        agentId: promptProfileAgentIdForFolder(input.agentFolder),
        virtualScope: PROMPT_PROFILE_VIRTUAL_SCOPE,
        virtualPath: profileVirtualPath(input.kind, input.agentFolder),
        content: input.content,
        contentType: 'text/markdown',
        createdBy: input.createdBy ?? input.actor,
        metadata: { promptProfileKind: input.kind },
        ...(input.expectedVersion !== undefined
          ? { expectedVersion: input.expectedVersion }
          : {}),
      });
    } catch (err) {
      if (err instanceof FileArtifactVersionConflictError) {
        throw new ProfileVersionConflictError(err.latestVersion);
      }
      throw err;
    }
    if (this.mirrorProfileFile) {
      try {
        await this.mirrorProfileFile({
          agentFolder: input.agentFolder,
          fileName: PROFILE_FILE_NAMES[input.kind],
          content: input.content,
          version: artifact.version,
        });
      } catch (error) {
        await this.reportSideEffectError({
          sideEffect: 'mirror',
          error,
          agentFolder: input.agentFolder,
          kind: input.kind,
          version: artifact.version,
        });
      }
    }
    if (this.audit) {
      try {
        await this.audit({
          action: 'update',
          agentFolder: input.agentFolder,
          kind: input.kind,
          version: artifact.version,
          contentHash: artifact.contentHash,
          actor: input.actor,
          approvalSource: input.approvalSource,
        });
      } catch (error) {
        await this.reportSideEffectError({
          sideEffect: 'audit',
          error,
          agentFolder: input.agentFolder,
          kind: input.kind,
          version: artifact.version,
        });
      }
    }
    return { version: artifact.version, contentHash: artifact.contentHash };
  }

  private async reportSideEffectError(input: {
    sideEffect: 'mirror' | 'audit';
    error: unknown;
    agentFolder: string;
    kind: ProfileFileKind;
    version: number;
  }): Promise<void> {
    if (!this.onSideEffectError) return;
    try {
      await this.onSideEffectError(input);
    } catch {
      // The durable profile write already succeeded; reporting failures must
      // not make callers believe the profile update was rolled back.
    }
  }
}

export { FileArtifactNotFoundError };
