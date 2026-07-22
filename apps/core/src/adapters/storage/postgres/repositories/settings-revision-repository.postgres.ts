import { and, desc, eq } from 'drizzle-orm';

import type {
  AppendSettingsRevisionResult,
  SettingsRevision,
  SettingsRevisionRepository,
} from '../../../../domain/ports/fleet-capability-state.js';
import type { McpBindingAuthorityPrecondition } from '../../../../domain/mcp/mcp-servers.js';
import type { AgentId } from '../../../../domain/agent/agent.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';
import { assertExpectedMcpBindingsUnchanged } from './mcp-binding-authority-fence.postgres.js';
import { isUniqueViolation } from './worker-coordination-lease.postgres.js';

type SettingsRevisionRow =
  typeof pgSchema.settingsRevisionsPostgres.$inferSelect;

const MAX_APPEND_ATTEMPTS = 5;
// Keep replay preconditions out of the public settings document without adding
// a one-feature schema column. The repository owns this envelope and always
// decodes it back into the caller-visible note plus typed internal metadata.
const REVISION_METADATA_PREFIX = 'gantry:settings-revision-metadata:v1:';

interface StoredSettingsRevisionMetadata {
  note: string | null;
  mcpBindingPreconditionAgentIds: AgentId[];
  mcpBindingPreconditions: McpBindingAuthorityPrecondition[];
  mcpCapabilityGrantTokens: Record<string, string>;
}

function toSettingsRevision(row: SettingsRevisionRow): SettingsRevision {
  const metadata = decodeStoredRevisionMetadata(row.note);
  return {
    appId: row.appId,
    revision: row.revision,
    settingsDocument: (row.settingsDocumentJson ?? {}) as Record<
      string,
      unknown
    >,
    minReaderVersion: row.minReaderVersion,
    createdBy: row.createdBy,
    note: metadata.note,
    ...(metadata.mcpBindingPreconditionAgentIds.length > 0
      ? {
          mcpBindingPreconditionAgentIds:
            metadata.mcpBindingPreconditionAgentIds,
          mcpBindingPreconditions: metadata.mcpBindingPreconditions,
        }
      : {}),
    ...(Object.keys(metadata.mcpCapabilityGrantTokens).length > 0
      ? { mcpCapabilityGrantTokens: metadata.mcpCapabilityGrantTokens }
      : {}),
    createdAt: row.createdAt,
  };
}

function encodeStoredRevisionNote(input: {
  note?: string | null;
  expectedMcpBindingAgentIds?: AgentId[];
  expectedMcpBindings?: McpBindingAuthorityPrecondition[];
  mcpCapabilityGrantTokens?: Record<string, string>;
}): string | null {
  const note = input.note ?? null;
  if (
    !input.expectedMcpBindingAgentIds?.length &&
    !input.expectedMcpBindings?.length &&
    !Object.keys(input.mcpCapabilityGrantTokens ?? {}).length &&
    !note?.startsWith(REVISION_METADATA_PREFIX)
  ) {
    return note;
  }
  return `${REVISION_METADATA_PREFIX}${JSON.stringify({
    note,
    mcpBindingPreconditionAgentIds: input.expectedMcpBindingAgentIds ?? [
      ...new Set((input.expectedMcpBindings ?? []).map((item) => item.agentId)),
    ],
    mcpBindingPreconditions: input.expectedMcpBindings ?? [],
    mcpCapabilityGrantTokens: input.mcpCapabilityGrantTokens ?? {},
  } satisfies StoredSettingsRevisionMetadata)}`;
}

function decodeStoredRevisionMetadata(
  value: string | null,
): StoredSettingsRevisionMetadata {
  if (!value?.startsWith(REVISION_METADATA_PREFIX)) {
    return {
      note: value ?? null,
      mcpBindingPreconditionAgentIds: [],
      mcpBindingPreconditions: [],
      mcpCapabilityGrantTokens: {},
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(REVISION_METADATA_PREFIX.length));
  } catch {
    throw new Error('Invalid MCP binding preconditions on settings revision.');
  }
  if (!isStoredSettingsRevisionMetadata(parsed)) {
    throw new Error('Invalid MCP binding preconditions on settings revision.');
  }
  return parsed;
}

function isStoredSettingsRevisionMetadata(
  value: unknown,
): value is StoredSettingsRevisionMetadata {
  if (!value || typeof value !== 'object') return false;
  const metadata = value as Partial<StoredSettingsRevisionMetadata>;
  if (metadata.note !== null && typeof metadata.note !== 'string') return false;
  if (
    !Array.isArray(metadata.mcpBindingPreconditions) ||
    !metadata.mcpBindingPreconditions.every(isMcpBindingPrecondition)
  ) {
    return false;
  }
  if (metadata.mcpBindingPreconditionAgentIds === undefined) {
    metadata.mcpBindingPreconditionAgentIds = [
      ...new Set(metadata.mcpBindingPreconditions.map((item) => item.agentId)),
    ];
  }
  if (metadata.mcpCapabilityGrantTokens === undefined) {
    metadata.mcpCapabilityGrantTokens = {};
  }
  if (
    !metadata.mcpCapabilityGrantTokens ||
    typeof metadata.mcpCapabilityGrantTokens !== 'object' ||
    Array.isArray(metadata.mcpCapabilityGrantTokens) ||
    !Object.entries(metadata.mcpCapabilityGrantTokens).every(
      ([key, token]) =>
        key.length > 0 && typeof token === 'string' && token.length > 0,
    )
  ) {
    return false;
  }
  if (
    !Array.isArray(metadata.mcpBindingPreconditionAgentIds) ||
    !metadata.mcpBindingPreconditionAgentIds.every(
      (agentId) => typeof agentId === 'string',
    )
  ) {
    return false;
  }
  const agentIds = new Set(metadata.mcpBindingPreconditionAgentIds);
  return metadata.mcpBindingPreconditions.every((binding) =>
    agentIds.has(binding.agentId),
  );
}

function isMcpBindingPrecondition(
  value: unknown,
): value is McpBindingAuthorityPrecondition {
  if (!value || typeof value !== 'object') return false;
  const binding = value as Record<string, unknown>;
  return (
    typeof binding.id === 'string' &&
    typeof binding.appId === 'string' &&
    typeof binding.agentId === 'string' &&
    typeof binding.serverId === 'string' &&
    (binding.status === 'active' || binding.status === 'disabled') &&
    typeof binding.required === 'boolean' &&
    isStringArray(binding.permissionPolicyIds) &&
    isStringArray(binding.allowedToolPatterns) &&
    (binding.conversationId === undefined ||
      typeof binding.conversationId === 'string') &&
    (binding.threadId === undefined || typeof binding.threadId === 'string')
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

export class PostgresSettingsRevisionRepository implements SettingsRevisionRepository {
  constructor(private readonly db: CanonicalDb) {}

  async appendSettingsRevision(input: {
    appId: string;
    settingsDocument: Record<string, unknown>;
    minReaderVersion: number;
    createdBy: string;
    note?: string | null;
    expectedRevision?: number | null;
    expectedMcpBindingAgentIds?: AgentId[];
    expectedMcpBindings?: McpBindingAuthorityPrecondition[];
    mcpCapabilityGrantTokens?: Record<string, string>;
    now?: string;
  }): Promise<AppendSettingsRevisionResult> {
    const now = input.now ?? nowIso();
    if (
      (input.expectedMcpBindingAgentIds?.length ?? 0) > 0 ||
      (input.expectedMcpBindings?.length ?? 0) > 0
    ) {
      const expectedRevision = input.expectedRevision;
      if (expectedRevision === undefined || expectedRevision === null) {
        throw new Error(
          'Expected MCP bindings require a conditional settings revision append.',
        );
      }
      try {
        return await this.db.transaction(async (tx) => {
          await assertExpectedMcpBindingsUnchanged(tx, input);
          return this.appendAtExpectedRevisionWithDb(tx, {
            ...input,
            expectedRevision,
            now,
          });
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        return this.settingsRevisionConflict(input.appId, expectedRevision);
      }
    }
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== null
    ) {
      return this.appendAtExpectedRevision({
        ...input,
        expectedRevision: input.expectedRevision,
        now,
      });
    }
    const table = pgSchema.settingsRevisionsPostgres;
    // Unconditional append: allocate the next revision against the current max
    // and let the (app_id, revision) unique key serialize concurrent appends. A
    // losing append retries against the new max rather than overwriting.
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const latest = await this.getLatestSettingsRevision(input.appId);
      const revision = (latest?.revision ?? 0) + 1;
      const row: SettingsRevisionRow = {
        appId: input.appId,
        revision,
        settingsDocumentJson: input.settingsDocument,
        minReaderVersion: input.minReaderVersion,
        createdBy: input.createdBy,
        note: encodeStoredRevisionNote(input),
        createdAt: now,
      };
      try {
        await this.db.insert(table).values(row);
        return { status: 'appended', revision: toSettingsRevision(row) };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    throw new Error(
      `Failed to allocate a settings revision for ${input.appId} after ${MAX_APPEND_ATTEMPTS} attempts`,
    );
  }

  /**
   * Conditional append (optimistic concurrency): insert exactly
   * `expectedRevision + 1` with NO retry past a conflict. The stale-head check
   * catches an outdated expectation up front; the (app_id, revision) unique key
   * then atomically arbitrates the race two same-expectation writers can still
   * reach — exactly one insert wins, the loser maps the unique violation to a
   * conflict instead of silently appending the next revision (lost update).
   */
  private async appendAtExpectedRevision(input: {
    appId: string;
    settingsDocument: Record<string, unknown>;
    minReaderVersion: number;
    createdBy: string;
    note?: string | null;
    expectedMcpBindingAgentIds?: AgentId[];
    expectedMcpBindings?: McpBindingAuthorityPrecondition[];
    mcpCapabilityGrantTokens?: Record<string, string>;
    expectedRevision: number;
    now: string;
  }): Promise<AppendSettingsRevisionResult> {
    try {
      return await this.appendAtExpectedRevisionWithDb(this.db, input);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return this.settingsRevisionConflict(input.appId, input.expectedRevision);
    }
  }

  private async appendAtExpectedRevisionWithDb(
    db: CanonicalExecutor,
    input: {
      appId: string;
      settingsDocument: Record<string, unknown>;
      minReaderVersion: number;
      createdBy: string;
      note?: string | null;
      expectedMcpBindingAgentIds?: AgentId[];
      expectedMcpBindings?: McpBindingAuthorityPrecondition[];
      mcpCapabilityGrantTokens?: Record<string, string>;
      expectedRevision: number;
      now: string;
    },
  ): Promise<AppendSettingsRevisionResult> {
    const latest = await this.getLatestSettingsRevisionWithDb(db, input.appId);
    const currentRevision = latest?.revision ?? 0;
    if (currentRevision !== input.expectedRevision) {
      return {
        status: 'conflict',
        expectedRevision: input.expectedRevision,
        actualRevision: currentRevision,
      };
    }
    const row: SettingsRevisionRow = {
      appId: input.appId,
      revision: input.expectedRevision + 1,
      settingsDocumentJson: input.settingsDocument,
      minReaderVersion: input.minReaderVersion,
      createdBy: input.createdBy,
      note: encodeStoredRevisionNote(input),
      createdAt: input.now,
    };
    await db.insert(pgSchema.settingsRevisionsPostgres).values(row);
    return { status: 'appended', revision: toSettingsRevision(row) };
  }

  private async settingsRevisionConflict(
    appId: string,
    expectedRevision: number,
  ): Promise<AppendSettingsRevisionResult> {
    const head = await this.getLatestSettingsRevision(appId);
    return {
      status: 'conflict',
      expectedRevision,
      actualRevision: head?.revision ?? expectedRevision + 1,
    };
  }

  async getLatestSettingsRevision(
    appId: string,
  ): Promise<SettingsRevision | null> {
    return this.getLatestSettingsRevisionWithDb(this.db, appId);
  }

  private async getLatestSettingsRevisionWithDb(
    db: CanonicalExecutor,
    appId: string,
  ): Promise<SettingsRevision | null> {
    const rows = await db
      .select()
      .from(pgSchema.settingsRevisionsPostgres)
      .where(eq(pgSchema.settingsRevisionsPostgres.appId, appId))
      .orderBy(desc(pgSchema.settingsRevisionsPostgres.revision))
      .limit(1);
    return rows[0] ? toSettingsRevision(rows[0]) : null;
  }

  async getSettingsRevision(input: {
    appId: string;
    revision: number;
  }): Promise<SettingsRevision | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.settingsRevisionsPostgres)
      .where(
        and(
          eq(pgSchema.settingsRevisionsPostgres.appId, input.appId),
          eq(pgSchema.settingsRevisionsPostgres.revision, input.revision),
        ),
      )
      .limit(1);
    return rows[0] ? toSettingsRevision(rows[0]) : null;
  }

  async listRecentSettingsRevisions(input: {
    appId: string;
    limit: number;
  }): Promise<SettingsRevision[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.settingsRevisionsPostgres)
      .where(eq(pgSchema.settingsRevisionsPostgres.appId, input.appId))
      .orderBy(desc(pgSchema.settingsRevisionsPostgres.revision))
      .limit(Math.max(1, Math.floor(input.limit)));
    return rows.map(toSettingsRevision);
  }
}
