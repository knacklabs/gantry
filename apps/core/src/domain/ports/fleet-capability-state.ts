export type RuntimeDependencyStatus =
  | 'queued'
  | 'baking'
  | 'uploaded'
  | 'activated'
  | 'failed';

export interface RuntimeDependencyArtifact {
  storageType: 'local-filesystem' | 'object-store';
  storageRef: string;
  contentHash: string;
  sizeBytes: number;
}

export interface RuntimeDependency {
  id: string;
  appId: string;
  /** Bake idempotency key. One manifest per (appId, manifestHash). */
  manifestHash: string;
  /** npm-only package specs (e.g. ["left-pad@1.3.0"]). */
  requestedPackages: string[];
  status: RuntimeDependencyStatus;
  artifact: RuntimeDependencyArtifact | null;
  failureReason: string | null;
  requestedByAgentId: string | null;
  approvedByConversationId: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeDependencyRepository {
  /**
   * Idempotent on (appId, manifestHash): a duplicate create returns the
   * existing manifest row rather than starting a second bake.
   */
  createRuntimeDependency(input: {
    id: string;
    appId: string;
    manifestHash: string;
    requestedPackages: string[];
    requestedByAgentId?: string | null;
    approvedByConversationId?: string | null;
    approvedAt?: string | null;
    now?: string;
  }): Promise<RuntimeDependency>;
  getRuntimeDependency(id: string): Promise<RuntimeDependency | null>;
  getRuntimeDependencyByManifestHash(input: {
    appId: string;
    manifestHash: string;
  }): Promise<RuntimeDependency | null>;
  listRuntimeDependencies(input: {
    appId: string;
    statuses?: RuntimeDependencyStatus[];
  }): Promise<RuntimeDependency[]>;
  /**
   * Status-transition writer used by the bake/reconciler chunks. Sets the
   * status and any produced artifact/failure metadata. Returns false when the
   * row no longer exists.
   *
   * When {@link UpdateRuntimeDependencyStatusInput.fromStatus} is provided the
   * write is a compare-and-set: it only applies when the row's current status
   * is one of the listed values, returning false otherwise. The bake uses this
   * as its lease — the worker that atomically flips `queued`→`baking` owns the
   * bake; concurrent claimants observe false and stand down.
   */
  updateRuntimeDependencyStatus(
    input: UpdateRuntimeDependencyStatusInput,
  ): Promise<boolean>;
}

export interface UpdateRuntimeDependencyStatusInput {
  id: string;
  status: RuntimeDependencyStatus;
  fromStatus?: RuntimeDependencyStatus | RuntimeDependencyStatus[];
  artifact?: RuntimeDependencyArtifact | null;
  failureReason?: string | null;
  now?: string;
}

/**
 * Reaper-facing query over rows whose bake stopped making progress: a worker
 * died mid-bake (row stuck at `baking`) or the pg-boss delivery was lost or
 * dead-lettered (row stuck at `queued`). Every status write bumps `updatedAt`,
 * so staleness is measured against it — no extra schema. Cross-app by design:
 * recovery must not depend on enumerating apps.
 */
export interface StaleRuntimeDependencyLister {
  listStaleRuntimeDependencies(input: {
    statuses: RuntimeDependencyStatus[];
    updatedBefore: string;
  }): Promise<RuntimeDependency[]>;
}

export interface SettingsRevision {
  appId: string;
  /** Monotonic per appId, allocated transactionally on append. */
  revision: number;
  settingsDocument: Record<string, unknown>;
  minReaderVersion: number;
  createdBy: string;
  note: string | null;
  createdAt: string;
}

export type AppendSettingsRevisionResult =
  | { status: 'appended'; revision: SettingsRevision }
  | {
      /**
       * The optimistic-concurrency guard failed: the current head revision is
       * not `expectedRevision`. Exactly one of two concurrent conditional
       * appends with the same `expectedRevision` wins; the loser gets this.
       */
      status: 'conflict';
      expectedRevision: number;
      actualRevision: number;
    };

export interface SettingsRevisionRepository {
  /**
   * Append a new desired-state revision.
   *
   * Without `expectedRevision` the next revision number is allocated
   * transactionally; concurrent appends serialize on the (appId, revision)
   * unique key and retry against the latest.
   *
   * With `expectedRevision` the append is a conditional write: the row is
   * inserted as exactly `expectedRevision + 1` with NO retry past a conflict —
   * a stale head or a lost insert race returns `status: 'conflict'` so callers
   * surface the contracted 409 instead of silently appending the next revision.
   */
  appendSettingsRevision(input: {
    appId: string;
    settingsDocument: Record<string, unknown>;
    minReaderVersion: number;
    createdBy: string;
    note?: string | null;
    expectedRevision?: number | null;
    now?: string;
  }): Promise<AppendSettingsRevisionResult>;
  getLatestSettingsRevision(appId: string): Promise<SettingsRevision | null>;
  getSettingsRevision(input: {
    appId: string;
    revision: number;
  }): Promise<SettingsRevision | null>;
  listRecentSettingsRevisions(input: {
    appId: string;
    limit: number;
  }): Promise<SettingsRevision[]>;
}
