import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Pool } from 'pg';
import type {
  Agent,
  AgentConfigVersion,
  LlmProfileId,
} from '../../../../domain/agent/agent.js';
import type { App } from '../../../../domain/app/app.js';
import type {
  AgentConversationBinding,
  ConversationApprover,
  ProviderConnection,
  ProviderId,
} from '../../../../domain/provider/provider.js';
import type {
  Conversation,
  ConversationThread,
} from '../../../../domain/conversation/conversation.js';
import type { AgentRun } from '../../../../domain/events/events.js';
import type { MemorySubject } from '../../../../domain/memory/memory.js';
import type {
  Message,
  MessageAttachment,
  MessagePart,
} from '../../../../domain/messages/messages.js';
import type {
  PermissionDecision,
  PermissionPolicy,
  PermissionRule,
} from '../../../../domain/permissions/permissions.js';
import type {
  AgentConfigRepository,
  AgentRepository,
  AgentRunRepository,
  AgentSessionDigestRepository,
  AgentSessionRepository,
  AgentSessionSummaryRepository,
  AppRepository,
  CapabilitySecretRepository,
  ProviderConnectionRepository,
  ConversationRepository,
  MessageRepository,
  McpServerRepository,
  PermissionRepository,
  ProviderSessionRepository,
  RuntimeEventRepository,
  SandboxRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
  OutboundDeliveryRepository,
} from '../../../../domain/ports/repositories.js';
import type {
  SandboxLease,
  SandboxProfile,
  WorkspaceSnapshot,
} from '../../../../domain/sandbox/sandbox.js';
import type { AgentSession } from '../../../../domain/sessions/sessions.js';
import type { ExternalRef } from '../../../../shared/ids/branded-id.js';
import * as pgSchema from '../schema/schema.js';
import {
  jsonb,
  type CanonicalDb,
} from './canonical-graph-repository.postgres.js';
import {
  PostgresAgentSessionRepository,
  PostgresAgentSessionDigestRepository,
  PostgresAgentSessionSummaryRepository,
  PostgresProviderSessionRepository,
} from './session-repositories.postgres.js';
import { PostgresMcpServerRepository } from './mcp-server-repository.postgres.js';
import { PostgresSkillCatalogRepository } from './skill-repository.postgres.js';
import { PostgresRuntimeEventRepository } from './runtime-event-repository.postgres.js';
import { PostgresToolCatalogRepository } from './tool-repository.postgres.js';
import { PostgresAgentRepository } from './agent-repository.postgres.js';
import { PostgresOutboundDeliveryRepository } from './outbound-delivery-repository.postgres.js';
import { PostgresCapabilitySecretRepository } from './capability-secret-repository.postgres.js';
export interface PostgresDomainRepositoryBundle {
  apps: AppRepository;
  agents: AgentRepository;
  agentConfigs: AgentConfigRepository;
  providerConnections: ProviderConnectionRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  agentSessions: AgentSessionRepository;
  agentSessionDigests: AgentSessionDigestRepository;
  providerSessions: ProviderSessionRepository;
  agentSessionSummaries: AgentSessionSummaryRepository;
  agentRuns: AgentRunRepository;
  runtimeEvents: RuntimeEventRepository;
  tools: ToolCatalogRepository;
  skills: SkillCatalogRepository;
  capabilitySecrets: CapabilitySecretRepository;
  mcpServers: McpServerRepository;
  permissions: PermissionRepository;
  sandboxes: SandboxRepository;
  outboundDeliveries: OutboundDeliveryRepository;
}
type JsonRecord = Record<string, unknown>;
function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}
function encodeJsonOrNull(value: unknown | undefined): string | null {
  return value === undefined ? null : encodeJson(value);
}
function jsonbOrNull(value: unknown | undefined): unknown | null {
  return value === undefined ? null : value;
}
function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  if (value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    if (!(err instanceof SyntaxError)) {
      throw err;
    }
    return fallback;
  }
}
function toIsoTimestamp(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === '23505'
  );
}
function parseJsonArray<T extends string>(value: unknown): T[] {
  const parsed = parseJson<unknown>(value, []);
  return Array.isArray(parsed)
    ? (parsed.filter((v) => typeof v === 'string') as T[])
    : [];
}
function safeIdPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._:@-]/g, '_');
}
function channelControlApproverId(
  conversationId: string,
  externalUserId: string,
): string {
  return `channel-control:${safeIdPart(conversationId)}:${safeIdPart(externalUserId)}`;
}
function externalRef<Kind extends string>(
  value: unknown,
  fallbackKind: Kind,
  fallbackValue?: string | null,
): ExternalRef<Kind> | undefined {
  const parsed = parseJson<Partial<ExternalRef<Kind>> & JsonRecord>(value, {});
  if (typeof parsed.kind === 'string' && typeof parsed.value === 'string') {
    return { kind: parsed.kind as Kind, value: parsed.value };
  }
  const fallbackRefValue =
    typeof parsed.jid === 'string'
      ? parsed.jid
      : typeof parsed.threadId === 'string'
        ? parsed.threadId
        : typeof parsed.externalId === 'string'
          ? parsed.externalId
          : fallbackValue;
  return fallbackRefValue
    ? { kind: fallbackKind, value: fallbackRefValue }
    : undefined;
}
function jsonTextEquals(column: unknown, keys: string[], value: string): SQL {
  return sql`(${column} IS NOT NULL AND (${sql.join(
    keys.map((key) => sql`${column}::jsonb->>${key} = ${value}`),
    sql` OR `,
  )}))`;
}
function _memorySubjectFromRow(row: {
  appId: string;
  agentId: string | null;
  subjectType: string;
  subjectId: string;
  userId: string | null;
  conversationId: string | null;
  threadId: string | null;
}): MemorySubject {
  if (row.subjectType === 'agent') {
    return {
      kind: 'agent',
      appId: row.appId,
      agentId: row.subjectId,
    } as MemorySubject;
  }
  if (row.subjectType === 'user') {
    return {
      kind: 'user',
      appId: row.appId,
      userId: row.userId ?? row.subjectId,
    } as MemorySubject;
  }
  if (row.subjectType === 'conversation') {
    return {
      kind: 'conversation',
      appId: row.appId,
      conversationId: row.conversationId ?? row.subjectId,
    } as MemorySubject;
  }
  if (row.subjectType === 'thread') {
    return {
      kind: 'thread',
      appId: row.appId,
      conversationId: row.conversationId ?? '',
      threadId: row.threadId ?? row.subjectId,
    } as MemorySubject;
  }
  return { kind: 'app', appId: row.appId } as MemorySubject;
}
function messagePartToPayload(part: MessagePart): Record<string, unknown> {
  switch (part.kind) {
    case 'text':
      return { text: part.text };
    case 'markdown':
      return { markdown: part.markdown };
    case 'code':
      return { language: part.language, code: part.code };
    case 'structured':
      return { value: part.value };
    case 'tool_result':
      return { toolId: part.toolId, value: part.value };
    case 'redacted':
      return { reason: part.reason };
  }
}
function payloadToMessagePart(kind: string, payloadJson: unknown): MessagePart {
  const payload = parseJson<JsonRecord>(payloadJson, {});
  switch (kind) {
    case 'markdown':
      return { kind: 'markdown', markdown: String(payload.markdown ?? '') };
    case 'code':
      return {
        kind: 'code',
        language:
          typeof payload.language === 'string' ? payload.language : undefined,
        code: String(payload.code ?? ''),
      };
    case 'structured':
      return { kind: 'structured', value: payload.value };
    case 'tool_result':
      return {
        kind: 'tool_result',
        toolId: String(payload.toolId ?? ''),
        value: payload.value,
      };
    case 'redacted':
      return { kind: 'redacted', reason: String(payload.reason ?? '') };
    default:
      return { kind: 'text', text: String(payload.text ?? '') };
  }
}
export class PostgresAppRepository implements AppRepository {
  constructor(private readonly db: CanonicalDb) {}
  async getApp(id: App['id']): Promise<App | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.appsPostgres)
      .where(eq(pgSchema.appsPostgres.id, id))
      .limit(1);
    return (rows[0] as App | undefined) ?? null;
  }
  async saveApp(app: App): Promise<void> {
    await this.db
      .insert(pgSchema.appsPostgres)
      .values(app)
      .onConflictDoUpdate({
        target: pgSchema.appsPostgres.id,
        set: {
          slug: app.slug,
          name: app.name,
          status: app.status,
          updatedAt: app.updatedAt,
        },
      });
  }
}
export class PostgresAgentConfigRepository implements AgentConfigRepository {
  constructor(private readonly db: CanonicalDb) {}
  async getConfigVersion(
    id: AgentConfigVersion['id'],
  ): Promise<AgentConfigVersion | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentConfigVersionsPostgres)
      .where(eq(pgSchema.agentConfigVersionsPostgres.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      appId: row.appId,
      agentId: row.agentId,
      version: row.version,
      promptProfileRef: row.promptProfileRef,
      llmProfileId: row.llmProfileId as LlmProfileId,
      toolIds: parseJsonArray(row.toolIdsJson),
      skillIds: parseJsonArray(row.skillIdsJson),
      permissionPolicyIds: parseJsonArray(row.permissionPolicyIdsJson),
      sandboxProfileId: row.sandboxProfileId ?? undefined,
      workspaceSnapshotId: row.workspaceSnapshotId ?? undefined,
      runtimeLimits: parseJson<AgentConfigVersion['runtimeLimits']>(
        row.runtimeLimitsJson,
        undefined,
      ),
      createdAt: row.createdAt,
    } as AgentConfigVersion;
  }
  async saveConfigVersion(version: AgentConfigVersion): Promise<void> {
    await this.db
      .insert(pgSchema.agentConfigVersionsPostgres)
      .values({
        id: version.id,
        appId: version.appId,
        agentId: version.agentId,
        version: version.version,
        promptProfileRef: version.promptProfileRef,
        llmProfileId: version.llmProfileId,
        toolIdsJson: encodeJson(version.toolIds),
        skillIdsJson: encodeJson(version.skillIds),
        permissionPolicyIdsJson: encodeJson(version.permissionPolicyIds),
        sandboxProfileId: version.sandboxProfileId ?? null,
        workspaceSnapshotId: version.workspaceSnapshotId ?? null,
        runtimeLimitsJson: encodeJson(version.runtimeLimits ?? {}),
        createdAt: version.createdAt,
      })
      .onConflictDoNothing();
  }
}
export class PostgresProviderConnectionRepository implements ProviderConnectionRepository {
  constructor(private readonly db: CanonicalDb) {}
  async listProviderConnections(
    appId: ProviderConnection['appId'],
  ): Promise<ProviderConnection[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.providerConnectionsPostgres)
      .where(eq(pgSchema.providerConnectionsPostgres.appId, appId))
      .orderBy(asc(pgSchema.providerConnectionsPostgres.createdAt));
    return rows.map((row) => this.providerConnectionFromRow(row));
  }
  async getProviderConnection(
    id: ProviderConnection['id'],
  ): Promise<ProviderConnection | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.providerConnectionsPostgres)
      .where(eq(pgSchema.providerConnectionsPostgres.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return this.providerConnectionFromRow(row);
  }
  private providerConnectionFromRow(
    row: typeof pgSchema.providerConnectionsPostgres.$inferSelect,
  ): ProviderConnection {
    return {
      id: row.id,
      appId: row.appId,
      providerId: row.providerId as ProviderId,
      externalInstallationRef: externalRef(
        row.externalRefJson,
        'provider_connection',
      ),
      label: row.label,
      status: row.status as ProviderConnection['status'],
      config: parseJson<Record<string, unknown>>(row.configJson, {}),
      runtimeSecretRefs: parseJsonArray(row.runtimeSecretRefsJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as unknown as ProviderConnection;
  }
  async saveProviderConnection(
    providerConnection: ProviderConnection,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(pgSchema.providersPostgres)
        .values({
          id: providerConnection.providerId,
          displayName: providerConnection.providerId,
        })
        .onConflictDoNothing();
      await tx
        .insert(pgSchema.providerConnectionsPostgres)
        .values({
          id: providerConnection.id,
          appId: providerConnection.appId,
          providerId: providerConnection.providerId,
          externalRefJson: encodeJsonOrNull(
            providerConnection.externalInstallationRef,
          ),
          label: providerConnection.label,
          status: providerConnection.status,
          configJson: encodeJson(providerConnection.config ?? {}),
          runtimeSecretRefsJson: encodeJson(
            providerConnection.runtimeSecretRefs,
          ),
          createdAt: providerConnection.createdAt,
          updatedAt: providerConnection.updatedAt,
        })
        .onConflictDoUpdate({
          target: pgSchema.providerConnectionsPostgres.id,
          set: {
            externalRefJson: encodeJsonOrNull(
              providerConnection.externalInstallationRef,
            ),
            label: providerConnection.label,
            status: providerConnection.status,
            configJson: encodeJson(providerConnection.config ?? {}),
            runtimeSecretRefsJson: encodeJson(
              providerConnection.runtimeSecretRefs,
            ),
            updatedAt: providerConnection.updatedAt,
          },
        });
    });
  }
  async updateProviderConnection(input: {
    appId: ProviderConnection['appId'];
    id: ProviderConnection['id'];
    patch: {
      externalInstallationRef?:
        | ProviderConnection['externalInstallationRef']
        | null;
      label?: string;
      status?: ProviderConnection['status'];
      config?: ProviderConnection['config'];
      runtimeSecretRefs?: ProviderConnection['runtimeSecretRefs'];
    };
    updatedAt: string;
  }): Promise<ProviderConnection | null> {
    const set: Partial<
      typeof pgSchema.providerConnectionsPostgres.$inferInsert
    > = {
      updatedAt: input.updatedAt,
    };
    if (input.patch.label !== undefined) set.label = input.patch.label;
    if (input.patch.status !== undefined) set.status = input.patch.status;
    if (input.patch.config !== undefined) {
      set.configJson = encodeJson(input.patch.config ?? {});
    }
    if (input.patch.runtimeSecretRefs !== undefined) {
      set.runtimeSecretRefsJson = encodeJson(input.patch.runtimeSecretRefs);
    }
    if (input.patch.externalInstallationRef !== undefined) {
      set.externalRefJson = encodeJsonOrNull(
        input.patch.externalInstallationRef ?? undefined,
      );
    }
    const rows = await this.db
      .update(pgSchema.providerConnectionsPostgres)
      .set(set)
      .where(
        and(
          eq(pgSchema.providerConnectionsPostgres.appId, input.appId),
          eq(pgSchema.providerConnectionsPostgres.id, input.id),
        ),
      )
      .returning();
    return rows[0] ? this.providerConnectionFromRow(rows[0]) : null;
  }
  async disableProviderConnection(input: {
    appId: ProviderConnection['appId'];
    id: ProviderConnection['id'];
    updatedAt: string;
  }): Promise<ProviderConnection | null> {
    await this.db
      .update(pgSchema.providerConnectionsPostgres)
      .set({ status: 'disabled', updatedAt: input.updatedAt })
      .where(
        and(
          eq(pgSchema.providerConnectionsPostgres.appId, input.appId),
          eq(pgSchema.providerConnectionsPostgres.id, input.id),
        ),
      );
    return await this.getProviderConnection(input.id);
  }
  async saveAgentConversationBinding(
    binding: AgentConversationBinding,
  ): Promise<void> {
    await this.db
      .insert(pgSchema.agentConversationBindingsPostgres)
      .values({
        id: binding.id,
        appId: binding.appId,
        agentId: binding.agentId,
        providerConnectionId: binding.providerConnectionId,
        conversationId: binding.conversationId,
        threadId: binding.threadId ?? null,
        displayName: binding.displayName,
        status: binding.status,
        triggerMode: binding.triggerMode,
        triggerPattern: binding.triggerPattern ?? null,
        requiresTrigger: binding.requiresTrigger,
        memoryScope: binding.memoryScope,
        memorySubjectJson: encodeJson(binding.memorySubject),
        workspaceSnapshotId: binding.workspaceSnapshotId ?? null,
        permissionPolicyIdsJson: encodeJson(binding.permissionPolicyIds),
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.agentConversationBindingsPostgres.id,
        set: {
          agentId: binding.agentId,
          providerConnectionId: binding.providerConnectionId,
          conversationId: binding.conversationId,
          threadId: binding.threadId ?? null,
          displayName: binding.displayName,
          status: binding.status,
          triggerMode: binding.triggerMode,
          triggerPattern: binding.triggerPattern ?? null,
          requiresTrigger: binding.requiresTrigger,
          memoryScope: binding.memoryScope,
          memorySubjectJson: encodeJson(binding.memorySubject),
          workspaceSnapshotId: binding.workspaceSnapshotId ?? null,
          permissionPolicyIdsJson: encodeJson(binding.permissionPolicyIds),
          updatedAt: binding.updatedAt,
        },
      });
  }
  async disableAgentConversationBinding(input: {
    appId: App['id'];
    agentId: Agent['id'];
    conversationId: Conversation['id'];
    threadId?: ConversationThread['id'];
    updatedAt: string;
  }): Promise<AgentConversationBinding | null> {
    const b = pgSchema.agentConversationBindingsPostgres;
    const rows = await this.db
      .update(b)
      .set({ status: 'disabled', updatedAt: input.updatedAt })
      .where(
        and(
          eq(b.appId, input.appId),
          eq(b.agentId, input.agentId),
          eq(b.conversationId, input.conversationId),
          sql`${b.id} not like 'conversation-route:%'`,
          input.threadId ? eq(b.threadId, input.threadId) : isNull(b.threadId),
        ),
      )
      .returning();
    return rows[0] ? this.bindingFromRow(rows[0]) : null;
  }
  async getAgentConversationBinding(input: {
    appId: App['id'];
    agentId: Agent['id'];
    conversationId: Conversation['id'];
    threadId?: ConversationThread['id'];
  }): Promise<AgentConversationBinding | null> {
    const b = pgSchema.agentConversationBindingsPostgres;
    const controlBindingPredicate = sql`${b.id} not like 'conversation-route:%'`;
    const threadPredicate = input.threadId
      ? or(eq(b.threadId, input.threadId), isNull(b.threadId))
      : isNull(b.threadId);
    const rows = await this.db
      .select()
      .from(b)
      .where(
        and(
          eq(b.appId, input.appId),
          eq(b.agentId, input.agentId),
          eq(b.conversationId, input.conversationId),
          controlBindingPredicate,
          threadPredicate,
        ),
      )
      .orderBy(
        sql`CASE WHEN ${b.threadId} IS NULL THEN 1 ELSE 0 END`,
        asc(b.id),
      )
      .limit(1);
    return rows[0] ? this.bindingFromRow(rows[0]) : null;
  }
  async isAgentEnabledInConversation(input: {
    appId: App['id'];
    agentId: Agent['id'];
    conversationId: Conversation['id'];
    threadId?: ConversationThread['id'];
  }): Promise<boolean> {
    const b = await this.getAgentConversationBinding(input);
    if (!b) return false;
    if (b.status !== 'active') return false;
    const rows = await this.db
      .select({ id: pgSchema.agentsPostgres.id })
      .from(pgSchema.agentsPostgres)
      .innerJoin(
        pgSchema.providerConnectionsPostgres,
        eq(pgSchema.providerConnectionsPostgres.id, b.providerConnectionId),
      )
      .innerJoin(
        pgSchema.conversationsPostgres,
        eq(pgSchema.conversationsPostgres.id, b.conversationId),
      )
      .where(
        and(
          eq(pgSchema.agentsPostgres.id, b.agentId),
          eq(pgSchema.agentsPostgres.status, 'active'),
          eq(pgSchema.providerConnectionsPostgres.status, 'active'),
          eq(pgSchema.conversationsPostgres.status, 'active'),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
  async listAgentConversationBindings(
    appId: App['id'],
    agentId?: Agent['id'],
  ): Promise<AgentConversationBinding[]> {
    const b = pgSchema.agentConversationBindingsPostgres;
    const rows = await this.db
      .select()
      .from(b)
      .where(
        and(
          eq(b.appId, appId),
          agentId ? eq(b.agentId, agentId) : undefined,
          sql`${b.id} not like 'conversation-route:%'`,
        ),
      )
      .orderBy(asc(b.createdAt));
    return rows.map((row) => this.bindingFromRow(row));
  }
  async listAgentConversationBindingsByConversation(input: {
    appId: App['id'];
    conversationId: Conversation['id'];
  }): Promise<AgentConversationBinding[]> {
    const b = pgSchema.agentConversationBindingsPostgres;
    const rows = await this.db
      .select()
      .from(b)
      .where(
        and(
          eq(b.appId, input.appId),
          eq(b.conversationId, input.conversationId),
          sql`${b.id} not like 'conversation-route:%'`,
        ),
      )
      .orderBy(asc(b.createdAt));
    return rows.map((row) => this.bindingFromRow(row));
  }
  private bindingFromRow(
    row: typeof pgSchema.agentConversationBindingsPostgres.$inferSelect,
  ): AgentConversationBinding {
    return {
      id: row.id,
      appId: row.appId,
      agentId: row.agentId,
      providerConnectionId: row.providerConnectionId,
      conversationId: row.conversationId,
      threadId: row.threadId ?? undefined,
      displayName: row.displayName,
      status: (row.status ?? 'active') as AgentConversationBinding['status'],
      triggerMode: (row.triggerMode ??
        (row.requiresTrigger
          ? 'keyword'
          : 'always')) as AgentConversationBinding['triggerMode'],
      triggerPattern: row.triggerPattern ?? undefined,
      requiresTrigger: row.requiresTrigger,
      memoryScope: (row.memoryScope ??
        'conversation') as AgentConversationBinding['memoryScope'],
      memorySubject: parseJson<MemorySubject>(row.memorySubjectJson, {
        kind: 'conversation',
        appId: row.appId,
        conversationId: row.conversationId,
      } as MemorySubject),
      workspaceSnapshotId: row.workspaceSnapshotId ?? undefined,
      permissionPolicyIds: parseJsonArray(row.permissionPolicyIdsJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as AgentConversationBinding;
  }
}
export class PostgresConversationRepository implements ConversationRepository {
  constructor(private readonly db: CanonicalDb) {}
  async listConversations(input: {
    appId: Conversation['appId'];
    providerConnectionId?: ProviderConnection['id'];
  }): Promise<Conversation[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.conversationsPostgres)
      .where(
        and(
          eq(pgSchema.conversationsPostgres.appId, input.appId),
          input.providerConnectionId
            ? eq(
                pgSchema.conversationsPostgres.providerConnectionId,
                input.providerConnectionId,
              )
            : undefined,
        ),
      )
      .orderBy(asc(pgSchema.conversationsPostgres.createdAt));
    return rows.map((row) => this.conversationFromRow(row));
  }
  async getConversation(id: Conversation['id']): Promise<Conversation | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.conversationsPostgres)
      .where(eq(pgSchema.conversationsPostgres.id, id))
      .limit(1);
    return rows[0] ? this.conversationFromRow(rows[0]) : null;
  }
  async getConversationByExternalRef(input: {
    appId: App['id'];
    providerId: ProviderId;
    providerConnectionId: ProviderConnection['id'];
    externalConversationId: string;
  }): Promise<Conversation | null> {
    const c = pgSchema.conversationsPostgres;
    const ci = pgSchema.providerConnectionsPostgres;
    const rows = await this.db
      .select({ conversation: c })
      .from(c)
      .innerJoin(ci, eq(ci.id, c.providerConnectionId))
      .where(
        and(
          eq(c.appId, input.appId),
          eq(ci.providerId, input.providerId),
          eq(c.providerConnectionId, input.providerConnectionId),
          jsonTextEquals(
            c.externalRefJson,
            ['value', 'jid', 'externalConversationId'],
            input.externalConversationId,
          ),
        ),
      )
      .limit(1);
    return rows[0] ? this.conversationFromRow(rows[0].conversation) : null;
  }
  async findConversationByExternalValue(input: {
    appId: App['id'];
    externalConversationId: string;
  }): Promise<Conversation | null> {
    const c = pgSchema.conversationsPostgres;
    const rows = await this.db
      .select()
      .from(c)
      .where(
        and(
          eq(c.appId, input.appId),
          jsonTextEquals(
            c.externalRefJson,
            ['value', 'jid', 'externalConversationId'],
            input.externalConversationId,
          ),
        ),
      )
      .limit(1);
    return rows[0] ? this.conversationFromRow(rows[0]) : null;
  }
  async getThread(
    id: ConversationThread['id'],
  ): Promise<ConversationThread | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.conversationThreadsPostgres)
      .where(eq(pgSchema.conversationThreadsPostgres.id, id))
      .limit(1);
    return rows[0] ? this.threadFromRow(rows[0]) : null;
  }
  async getThreadByExternalRef(input: {
    appId: App['id'];
    providerId: ProviderId;
    conversationId: Conversation['id'];
    externalThreadId: string;
  }): Promise<ConversationThread | null> {
    const t = pgSchema.conversationThreadsPostgres;
    const c = pgSchema.conversationsPostgres;
    const ci = pgSchema.providerConnectionsPostgres;
    const rows = await this.db
      .select({ thread: t })
      .from(t)
      .innerJoin(c, eq(c.id, t.conversationId))
      .innerJoin(ci, eq(ci.id, c.providerConnectionId))
      .where(
        and(
          eq(t.appId, input.appId),
          eq(t.conversationId, input.conversationId),
          eq(ci.providerId, input.providerId),
          jsonTextEquals(
            t.externalRefJson,
            ['value', 'threadId', 'externalThreadId'],
            input.externalThreadId,
          ),
        ),
      )
      .limit(1);
    return rows[0] ? this.threadFromRow(rows[0].thread) : null;
  }
  async saveConversation(conversation: Conversation): Promise<void> {
    await this.db
      .insert(pgSchema.conversationsPostgres)
      .values({
        id: conversation.id,
        appId: conversation.appId,
        providerConnectionId: conversation.providerConnectionId,
        externalRefJson: encodeJsonOrNull(conversation.externalRef),
        kind: conversation.kind,
        title: conversation.title ?? null,
        status: conversation.status,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.conversationsPostgres.id,
        set: {
          providerConnectionId: conversation.providerConnectionId,
          externalRefJson: encodeJsonOrNull(conversation.externalRef),
          kind: conversation.kind,
          title: conversation.title ?? null,
          status: conversation.status,
          updatedAt: conversation.updatedAt,
        },
      });
  }
  async saveThread(thread: ConversationThread): Promise<void> {
    await this.db
      .insert(pgSchema.conversationThreadsPostgres)
      .values({
        id: thread.id,
        appId: thread.appId,
        conversationId: thread.conversationId,
        externalRefJson: encodeJsonOrNull(thread.externalRef),
        title: thread.title ?? null,
        status: thread.status,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.conversationThreadsPostgres.id,
        set: {
          externalRefJson: encodeJsonOrNull(thread.externalRef),
          title: thread.title ?? null,
          status: thread.status,
          updatedAt: thread.updatedAt,
        },
      });
  }
  async listThreads(
    conversationId: Conversation['id'],
  ): Promise<ConversationThread[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.conversationThreadsPostgres)
      .where(
        eq(pgSchema.conversationThreadsPostgres.conversationId, conversationId),
      )
      .orderBy(asc(pgSchema.conversationThreadsPostgres.createdAt));
    return rows.map((row) => this.threadFromRow(row));
  }
  async listParticipantExternalUserIds(
    conversationId: Conversation['id'],
  ): Promise<string[]> {
    const rows = await this.db
      .select({
        externalUserId:
          pgSchema.conversationParticipantsPostgres.externalUserId,
      })
      .from(pgSchema.conversationParticipantsPostgres)
      .where(
        and(
          eq(
            pgSchema.conversationParticipantsPostgres.conversationId,
            conversationId,
          ),
          eq(pgSchema.conversationParticipantsPostgres.status, 'active'),
        ),
      )
      .orderBy(asc(pgSchema.conversationParticipantsPostgres.externalUserId));
    return rows
      .map((row) => row.externalUserId?.trim() || '')
      .filter((id) => id.length > 0);
  }
  async listConversationApprovers(
    conversationId: Conversation['id'],
  ): Promise<ConversationApprover[]> {
    return this.listConversationApproverRows([conversationId]);
  }
  async listConversationApproversForConversations(
    conversationIds: readonly Conversation['id'][],
  ): Promise<ConversationApprover[]> {
    return this.listConversationApproverRows(conversationIds);
  }
  private async listConversationApproverRows(
    conversationIds: readonly Conversation['id'][],
  ): Promise<ConversationApprover[]> {
    if (conversationIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(pgSchema.conversationApproversPostgres)
      .where(
        inArray(pgSchema.conversationApproversPostgres.conversationId, [
          ...conversationIds,
        ]),
      )
      .orderBy(
        asc(pgSchema.conversationApproversPostgres.conversationId),
        asc(pgSchema.conversationApproversPostgres.externalUserId),
      );
    return rows.map((row) => ({
      id: row.id,
      appId: row.appId,
      conversationId: row.conversationId,
      externalUserId: row.externalUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })) as ConversationApprover[];
  }
  async replaceConversationApprovers(input: {
    appId: App['id'];
    conversationId: Conversation['id'];
    externalUserIds: string[];
    updatedAt: string;
  }): Promise<ConversationApprover[]> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(pgSchema.conversationApproversPostgres)
        .where(
          and(
            eq(pgSchema.conversationApproversPostgres.appId, input.appId),
            eq(
              pgSchema.conversationApproversPostgres.conversationId,
              input.conversationId,
            ),
          ),
        );
      if (input.externalUserIds.length === 0) return;
      await tx.insert(pgSchema.conversationApproversPostgres).values(
        input.externalUserIds.map((externalUserId) => ({
          id: channelControlApproverId(input.conversationId, externalUserId),
          appId: input.appId,
          conversationId: input.conversationId,
          externalUserId,
          createdAt: input.updatedAt,
          updatedAt: input.updatedAt,
        })),
      );
    });
    return this.listConversationApprovers(input.conversationId);
  }
  private conversationFromRow(
    row: typeof pgSchema.conversationsPostgres.$inferSelect,
  ): Conversation {
    return {
      id: row.id,
      appId: row.appId,
      providerConnectionId: row.providerConnectionId,
      externalRef: externalRef(row.externalRefJson, 'conversation'),
      kind: row.kind as Conversation['kind'],
      title: row.title ?? undefined,
      status: row.status as Conversation['status'],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as unknown as Conversation;
  }
  private threadFromRow(
    row: typeof pgSchema.conversationThreadsPostgres.$inferSelect,
  ): ConversationThread {
    return {
      id: row.id,
      appId: row.appId,
      conversationId: row.conversationId,
      externalRef: externalRef(row.externalRefJson, 'conversation_thread'),
      title: row.title ?? undefined,
      status: row.status as ConversationThread['status'],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as unknown as ConversationThread;
  }
}
export class PostgresMessageRepository implements MessageRepository {
  constructor(private readonly db: CanonicalDb) {}
  async getMessage(id: Message['id']): Promise<Message | null> {
    const m = pgSchema.messagesPostgres;
    const rows = await this.db.select().from(m).where(eq(m.id, id)).limit(1);
    const row = rows[0];
    if (!row) return null;
    const parts = await this.db
      .select()
      .from(pgSchema.messagePartsPostgres)
      .where(eq(pgSchema.messagePartsPostgres.messageId, row.id))
      .orderBy(asc(pgSchema.messagePartsPostgres.ordinal));
    const attachments = await this.db
      .select()
      .from(pgSchema.messageAttachmentsPostgres)
      .where(eq(pgSchema.messageAttachmentsPostgres.messageId, row.id))
      .orderBy(asc(pgSchema.messageAttachmentsPostgres.id));
    return this.messageFromRows(row, parts, attachments);
  }
  async saveMessage(message: Message): Promise<void> {
    try {
      await this.writeMessage(message);
    } catch (err) {
      if (!message.externalRef?.value || !isUniqueViolation(err)) {
        throw err;
      }
      await this.writeMessage(message);
    }
  }
  private async writeMessage(message: Message): Promise<void> {
    await this.db.transaction(async (tx) => {
      const c = pgSchema.conversationsPostgres;
      const ci = pgSchema.providerConnectionsPostgres;
      const channelRows = await tx
        .select({
          providerConnectionId: c.providerConnectionId,
          providerId: ci.providerId,
        })
        .from(c)
        .innerJoin(ci, eq(ci.id, c.providerConnectionId))
        .where(eq(c.id, message.conversationId))
        .limit(1);
      const channel = channelRows[0];
      if (!channel) {
        throw new Error(
          `Cannot save message ${message.id}: conversation ${message.conversationId} was not found`,
        );
      }
      const externalMessageId = message.externalRef?.value ?? null;
      let targetMessageId: Message['id'] = message.id;
      if (externalMessageId) {
        const duplicateRows = await tx
          .select({ id: pgSchema.messagesPostgres.id })
          .from(pgSchema.messagesPostgres)
          .where(
            and(
              eq(pgSchema.messagesPostgres.providerId, channel.providerId),
              eq(
                pgSchema.messagesPostgres.providerConnectionId,
                channel.providerConnectionId,
              ),
              eq(
                pgSchema.messagesPostgres.conversationId,
                message.conversationId,
              ),
              message.threadId
                ? eq(pgSchema.messagesPostgres.threadId, message.threadId)
                : isNull(pgSchema.messagesPostgres.threadId),
              eq(
                pgSchema.messagesPostgres.externalMessageId,
                externalMessageId,
              ),
            ),
          )
          .limit(1);
        targetMessageId = (duplicateRows[0]?.id ?? message.id) as Message['id'];
      }
      await tx
        .insert(pgSchema.messagesPostgres)
        .values({
          id: targetMessageId,
          appId: message.appId,
          providerId: channel.providerId,
          providerConnectionId: channel.providerConnectionId,
          conversationId: message.conversationId,
          threadId: message.threadId ?? null,
          externalMessageId,
          externalRefJson: jsonbOrNull(message.externalRef),
          direction: message.direction,
          senderUserId: message.senderUserId ?? null,
          senderDisplayName: message.senderDisplayName ?? null,
          trust: message.trust,
          createdAt: message.createdAt,
          receivedAt: message.receivedAt ?? null,
          deliveryStatus: message.deliveryStatus ?? null,
          deliveredAt: message.deliveredAt ?? null,
          deliveryError: message.deliveryError ?? null,
        })
        .onConflictDoUpdate({
          target: pgSchema.messagesPostgres.id,
          set: {
            externalMessageId,
            externalRefJson: jsonbOrNull(message.externalRef),
            direction: message.direction,
            senderUserId: message.senderUserId ?? null,
            senderDisplayName: message.senderDisplayName ?? null,
            trust: message.trust,
            receivedAt: message.receivedAt ?? null,
            deliveryStatus: message.deliveryStatus ?? null,
            deliveredAt: message.deliveredAt ?? null,
            deliveryError: message.deliveryError ?? null,
          },
        });
      await tx
        .delete(pgSchema.messagePartsPostgres)
        .where(eq(pgSchema.messagePartsPostgres.messageId, targetMessageId));
      await tx
        .delete(pgSchema.messageAttachmentsPostgres)
        .where(
          eq(pgSchema.messageAttachmentsPostgres.messageId, targetMessageId),
        );
      if (message.parts.length > 0) {
        await tx.insert(pgSchema.messagePartsPostgres).values(
          message.parts.map((part, ordinal) => ({
            messageId: targetMessageId,
            ordinal,
            kind: part.kind,
            payloadJson: jsonb(messagePartToPayload(part)),
          })),
        );
      }
      if (message.attachments.length > 0) {
        await tx.insert(pgSchema.messageAttachmentsPostgres).values(
          message.attachments.map((attachment) => ({
            id: attachment.id,
            messageId: targetMessageId,
            kind: attachment.kind,
            contentType: attachment.contentType ?? null,
            sizeBytes: attachment.sizeBytes ?? null,
            externalRefJson: jsonbOrNull(attachment.externalRef),
            storageRef: attachment.storageRef ?? null,
            trust: attachment.trust,
          })),
        );
      }
    });
  }
  async listMessages(input: {
    conversationId: Conversation['id'];
    threadId?: ConversationThread['id'];
    after?: string;
    limit?: number;
  }): Promise<Message[]> {
    const m = pgSchema.messagesPostgres;
    let afterFilter: SQL | undefined;
    if (input.after) {
      const afterRows = await this.db
        .select({ createdAt: m.createdAt, id: m.id })
        .from(m)
        .where(eq(m.id, input.after))
        .limit(1);
      const after = afterRows[0];
      if (after) {
        afterFilter = or(
          gt(m.createdAt, after.createdAt),
          and(eq(m.createdAt, after.createdAt), gt(m.id, after.id)),
        );
      }
    }
    const rows = await this.db
      .select()
      .from(m)
      .where(
        and(
          eq(m.conversationId, input.conversationId),
          input.threadId ? eq(m.threadId, input.threadId) : undefined,
          afterFilter,
        ),
      )
      .orderBy(asc(m.createdAt), asc(m.id))
      .limit(input.limit ?? 100);
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const parts = await this.db
      .select()
      .from(pgSchema.messagePartsPostgres)
      .where(inArray(pgSchema.messagePartsPostgres.messageId, ids))
      .orderBy(
        asc(pgSchema.messagePartsPostgres.messageId),
        asc(pgSchema.messagePartsPostgres.ordinal),
      );
    const attachments = await this.db
      .select()
      .from(pgSchema.messageAttachmentsPostgres)
      .where(inArray(pgSchema.messageAttachmentsPostgres.messageId, ids))
      .orderBy(
        asc(pgSchema.messageAttachmentsPostgres.messageId),
        asc(pgSchema.messageAttachmentsPostgres.id),
      );
    const partsByMessageId = new Map<
      string,
      Array<typeof pgSchema.messagePartsPostgres.$inferSelect>
    >();
    for (const part of parts) {
      const existing = partsByMessageId.get(part.messageId) ?? [];
      existing.push(part);
      partsByMessageId.set(part.messageId, existing);
    }
    const attachmentsByMessageId = new Map<
      string,
      Array<typeof pgSchema.messageAttachmentsPostgres.$inferSelect>
    >();
    for (const attachment of attachments) {
      const existing = attachmentsByMessageId.get(attachment.messageId) ?? [];
      existing.push(attachment);
      attachmentsByMessageId.set(attachment.messageId, existing);
    }
    return rows.map((row) =>
      this.messageFromRows(
        row,
        partsByMessageId.get(row.id) ?? [],
        attachmentsByMessageId.get(row.id) ?? [],
      ),
    );
  }
  async listRecentMessages(input: {
    conversationId: Conversation['id'];
    threadId?: ConversationThread['id'];
    after?: string;
    limit?: number;
  }): Promise<Message[]> {
    const m = pgSchema.messagesPostgres;
    let afterFilter: SQL | undefined;
    if (input.after) {
      const afterRows = await this.db
        .select({ createdAt: m.createdAt, id: m.id })
        .from(m)
        .where(eq(m.id, input.after))
        .limit(1);
      const after = afterRows[0];
      if (after) {
        afterFilter = or(
          gt(m.createdAt, after.createdAt),
          and(eq(m.createdAt, after.createdAt), gt(m.id, after.id)),
        );
      }
    }
    const rows = await this.db
      .select()
      .from(m)
      .where(
        and(
          eq(m.conversationId, input.conversationId),
          input.threadId ? eq(m.threadId, input.threadId) : undefined,
          afterFilter,
        ),
      )
      .orderBy(desc(m.createdAt), desc(m.id))
      .limit(input.limit ?? 100);
    const orderedRows = [...rows].reverse();
    if (orderedRows.length === 0) return [];
    const ids = orderedRows.map((row) => row.id);
    const parts = await this.db
      .select()
      .from(pgSchema.messagePartsPostgres)
      .where(inArray(pgSchema.messagePartsPostgres.messageId, ids))
      .orderBy(
        asc(pgSchema.messagePartsPostgres.messageId),
        asc(pgSchema.messagePartsPostgres.ordinal),
      );
    const attachments = await this.db
      .select()
      .from(pgSchema.messageAttachmentsPostgres)
      .where(inArray(pgSchema.messageAttachmentsPostgres.messageId, ids))
      .orderBy(
        asc(pgSchema.messageAttachmentsPostgres.messageId),
        asc(pgSchema.messageAttachmentsPostgres.id),
      );
    const partsByMessageId = new Map<
      string,
      Array<typeof pgSchema.messagePartsPostgres.$inferSelect>
    >();
    for (const part of parts) {
      const existing = partsByMessageId.get(part.messageId) ?? [];
      existing.push(part);
      partsByMessageId.set(part.messageId, existing);
    }
    const attachmentsByMessageId = new Map<
      string,
      Array<typeof pgSchema.messageAttachmentsPostgres.$inferSelect>
    >();
    for (const attachment of attachments) {
      const existing = attachmentsByMessageId.get(attachment.messageId) ?? [];
      existing.push(attachment);
      attachmentsByMessageId.set(attachment.messageId, existing);
    }
    return orderedRows.map((row) =>
      this.messageFromRows(
        row,
        partsByMessageId.get(row.id) ?? [],
        attachmentsByMessageId.get(row.id) ?? [],
      ),
    );
  }
  private messageFromRows(
    row: typeof pgSchema.messagesPostgres.$inferSelect,
    parts: Array<typeof pgSchema.messagePartsPostgres.$inferSelect>,
    attachments: Array<typeof pgSchema.messageAttachmentsPostgres.$inferSelect>,
  ): Message {
    return {
      id: row.id,
      appId: row.appId,
      conversationId: row.conversationId,
      threadId: row.threadId ?? undefined,
      externalRef: externalRef(
        row.externalRefJson,
        'message',
        row.externalMessageId,
      ),
      direction: row.direction as Message['direction'],
      senderUserId: row.senderUserId ?? undefined,
      senderDisplayName: row.senderDisplayName ?? undefined,
      trust: row.trust as Message['trust'],
      createdAt: toIsoTimestamp(row.createdAt),
      receivedAt: row.receivedAt ? toIsoTimestamp(row.receivedAt) : undefined,
      deliveryStatus: row.deliveryStatus ?? undefined,
      deliveredAt: row.deliveredAt
        ? toIsoTimestamp(row.deliveredAt)
        : undefined,
      deliveryError: row.deliveryError ?? undefined,
      parts: parts.map((part) =>
        payloadToMessagePart(part.kind, part.payloadJson),
      ),
      attachments: attachments.map(
        (attachment): MessageAttachment =>
          ({
            id: attachment.id,
            messageId: attachment.messageId,
            kind: attachment.kind as MessageAttachment['kind'],
            contentType: attachment.contentType ?? undefined,
            sizeBytes: attachment.sizeBytes ?? undefined,
            externalRef: externalRef(
              attachment.externalRefJson,
              'message_attachment',
            ),
            storageRef: attachment.storageRef ?? undefined,
            trust: attachment.trust as MessageAttachment['trust'],
          }) as unknown as MessageAttachment,
      ),
    } as unknown as Message;
  }
}
export class PostgresAgentRunRepository implements AgentRunRepository {
  constructor(private readonly db: CanonicalDb) {}
  async getAgentRun(id: AgentRun['id']): Promise<AgentRun | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentRunsPostgres)
      .where(eq(pgSchema.agentRunsPostgres.id, id))
      .limit(1);
    return rows[0] ? this.runFromRow(rows[0]) : null;
  }
  async saveAgentRun(run: AgentRun): Promise<void> {
    await this.db
      .insert(pgSchema.agentRunsPostgres)
      .values({
        id: run.id,
        appId: run.appId,
        agentId: run.agentId,
        configVersionId: run.configVersionId,
        sessionId: run.sessionId ?? null,
        conversationId: run.conversationId ?? null,
        threadId: run.threadId ?? null,
        messageId: run.messageId ?? null,
        jobId: run.jobId ?? null,
        llmProfileId: run.llmProfileId,
        permissionDecisionIdsJson: encodeJson(run.permissionDecisionIds),
        sandboxLeaseId: run.sandboxLeaseId ?? null,
        workspaceSnapshotId: run.workspaceSnapshotId ?? null,
        cause: run.cause,
        status: run.status,
        createdAt: run.createdAt,
        startedAt: run.startedAt ?? null,
        endedAt: run.endedAt ?? null,
        resultSummary: run.resultSummary ?? null,
        errorSummary: run.errorSummary ?? null,
      })
      .onConflictDoUpdate({
        target: pgSchema.agentRunsPostgres.id,
        set: {
          permissionDecisionIdsJson: encodeJson(run.permissionDecisionIds),
          sandboxLeaseId: run.sandboxLeaseId ?? null,
          workspaceSnapshotId: run.workspaceSnapshotId ?? null,
          status: run.status,
          startedAt: run.startedAt ?? null,
          endedAt: run.endedAt ?? null,
          resultSummary: run.resultSummary ?? null,
          errorSummary: run.errorSummary ?? null,
        },
      });
  }
  async listAgentRunsBySession(input: {
    sessionId: AgentSession['id'];
    limit?: number;
  }): Promise<AgentRun[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentRunsPostgres)
      .where(eq(pgSchema.agentRunsPostgres.sessionId, input.sessionId))
      .orderBy(
        desc(pgSchema.agentRunsPostgres.createdAt),
        desc(pgSchema.agentRunsPostgres.id),
      )
      .limit(input.limit ?? 100);
    return rows.map((row) => this.runFromRow(row));
  }
  private runFromRow(
    row: typeof pgSchema.agentRunsPostgres.$inferSelect,
  ): AgentRun {
    return {
      id: row.id,
      appId: row.appId,
      agentId: row.agentId,
      configVersionId: row.configVersionId,
      sessionId: row.sessionId ?? undefined,
      conversationId: row.conversationId ?? undefined,
      threadId: row.threadId ?? undefined,
      messageId: row.messageId ?? undefined,
      jobId: row.jobId ?? undefined,
      llmProfileId: row.llmProfileId as LlmProfileId,
      permissionDecisionIds: parseJsonArray(row.permissionDecisionIdsJson),
      sandboxLeaseId: row.sandboxLeaseId ?? undefined,
      workspaceSnapshotId: row.workspaceSnapshotId ?? undefined,
      cause: row.cause as AgentRun['cause'],
      status: row.status as AgentRun['status'],
      createdAt: row.createdAt,
      startedAt: row.startedAt ?? undefined,
      endedAt: row.endedAt ?? undefined,
      resultSummary: row.resultSummary ?? undefined,
      errorSummary: row.errorSummary ?? undefined,
    } as AgentRun;
  }
}
export class PostgresPermissionRepository implements PermissionRepository {
  constructor(private readonly db: CanonicalDb) {}
  async savePolicy(policy: PermissionPolicy): Promise<void> {
    await this.db
      .insert(pgSchema.permissionPoliciesPostgres)
      .values(policy)
      .onConflictDoUpdate({
        target: pgSchema.permissionPoliciesPostgres.id,
        set: {
          name: policy.name,
          description: policy.description ?? null,
          status: policy.status,
          updatedAt: policy.updatedAt,
        },
      });
  }
  async saveRule(rule: PermissionRule): Promise<void> {
    await this.db
      .insert(pgSchema.permissionRulesPostgres)
      .values({
        id: rule.id,
        appId: rule.appId,
        policyId: rule.policyId,
        priority: rule.priority,
        effect: rule.effect,
        matchJson: encodeJson(rule.match),
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.permissionRulesPostgres.id,
        set: {
          priority: rule.priority,
          effect: rule.effect,
          matchJson: encodeJson(rule.match),
          updatedAt: rule.updatedAt,
        },
      });
  }
  async saveDecision(decision: PermissionDecision): Promise<void> {
    await this.db
      .insert(pgSchema.permissionDecisionsPostgres)
      .values({
        id: decision.id,
        appId: decision.appId,
        policyId: decision.policyId ?? null,
        ruleIdsJson: encodeJson(decision.ruleIds),
        runId: decision.runId ?? null,
        toolId: decision.toolId ?? null,
        effect: decision.effect,
        reason: decision.reason,
        actorContextJson: encodeJsonOrNull(decision.actorContext),
        actionPreview: decision.actionPreview ?? null,
        approverRef: decision.approverRef ?? null,
        expiresAt: decision.expiresAt ?? null,
        createdAt: decision.createdAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.permissionDecisionsPostgres.id,
        set: {
          policyId: decision.policyId ?? null,
          ruleIdsJson: encodeJson(decision.ruleIds),
          runId: decision.runId ?? null,
          toolId: decision.toolId ?? null,
          effect: decision.effect,
          reason: decision.reason,
          actorContextJson: encodeJsonOrNull(decision.actorContext),
          actionPreview: decision.actionPreview ?? null,
          approverRef: decision.approverRef ?? null,
          expiresAt: decision.expiresAt ?? null,
        },
      });
  }
  async getDecision(
    id: PermissionDecision['id'],
  ): Promise<PermissionDecision | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.permissionDecisionsPostgres)
      .where(eq(pgSchema.permissionDecisionsPostgres.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      appId: row.appId,
      policyId: row.policyId ?? undefined,
      ruleIds: parseJsonArray(row.ruleIdsJson),
      runId: row.runId ?? undefined,
      toolId: row.toolId ?? undefined,
      effect: row.effect as PermissionDecision['effect'],
      reason: row.reason,
      actorContext: row.actorContextJson
        ? parseJson<JsonRecord>(row.actorContextJson, {})
        : undefined,
      actionPreview: row.actionPreview ?? undefined,
      approverRef: row.approverRef ?? undefined,
      expiresAt: row.expiresAt ?? undefined,
      createdAt: row.createdAt,
    } as PermissionDecision;
  }
}
export class PostgresSandboxRepository implements SandboxRepository {
  constructor(private readonly db: CanonicalDb) {}
  async getSandboxProfile(
    id: SandboxProfile['id'],
  ): Promise<SandboxProfile | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.sandboxProfilesPostgres)
      .where(eq(pgSchema.sandboxProfilesPostgres.id, id))
      .limit(1);
    return (rows[0] as SandboxProfile | undefined) ?? null;
  }
  async saveSandboxProfile(profile: SandboxProfile): Promise<void> {
    await this.db
      .insert(pgSchema.sandboxProfilesPostgres)
      .values(profile)
      .onConflictDoUpdate({
        target: pgSchema.sandboxProfilesPostgres.id,
        set: {
          name: profile.name,
          filesystem: profile.filesystem,
          network: profile.network,
          process: profile.process,
          browser: profile.browser,
          credentialAccess: profile.credentialAccess,
          timeoutMs: profile.timeoutMs,
          updatedAt: profile.updatedAt,
        },
      });
  }
  async getSandboxLease(id: SandboxLease['id']): Promise<SandboxLease | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.sandboxLeasesPostgres)
      .where(eq(pgSchema.sandboxLeasesPostgres.id, id))
      .limit(1);
    return (rows[0] as SandboxLease | undefined) ?? null;
  }
  async saveSandboxLease(lease: SandboxLease): Promise<void> {
    await this.db
      .insert(pgSchema.sandboxLeasesPostgres)
      .values({
        id: lease.id,
        appId: lease.appId,
        profileId: lease.profileId,
        runId: lease.runId,
        permissionDecisionId: lease.permissionDecisionId,
        status: lease.status,
        grantedAt: lease.grantedAt,
        expiresAt: lease.expiresAt,
        releasedAt: lease.releasedAt ?? null,
      })
      .onConflictDoUpdate({
        target: pgSchema.sandboxLeasesPostgres.id,
        set: {
          status: lease.status,
          releasedAt: lease.releasedAt ?? null,
        },
      });
  }
  async saveWorkspaceSnapshot(snapshot: WorkspaceSnapshot): Promise<void> {
    await this.db
      .insert(pgSchema.workspaceSnapshotsPostgres)
      .values({
        id: snapshot.id,
        appId: snapshot.appId,
        rootRef: snapshot.rootRef,
        mountsJson: encodeJson(snapshot.mounts),
        promptRefsJson: encodeJson(snapshot.promptRefs),
        contextRefsJson: encodeJson(snapshot.contextRefs),
        createdAt: snapshot.createdAt,
      })
      .onConflictDoNothing();
  }
  async getWorkspaceSnapshot(
    id: WorkspaceSnapshot['id'],
  ): Promise<WorkspaceSnapshot | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.workspaceSnapshotsPostgres)
      .where(eq(pgSchema.workspaceSnapshotsPostgres.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      appId: row.appId,
      rootRef: row.rootRef,
      mounts: parseJson(row.mountsJson, []),
      promptRefs: parseJsonArray(row.promptRefsJson),
      contextRefs: parseJsonArray(row.contextRefsJson),
      createdAt: row.createdAt,
    } as unknown as WorkspaceSnapshot;
  }
}
export function createPostgresDomainRepositories(
  db: CanonicalDb,
  _pool?: Pool,
): PostgresDomainRepositoryBundle {
  return {
    apps: new PostgresAppRepository(db),
    agents: new PostgresAgentRepository(db),
    agentConfigs: new PostgresAgentConfigRepository(db),
    providerConnections: new PostgresProviderConnectionRepository(db),
    conversations: new PostgresConversationRepository(db),
    messages: new PostgresMessageRepository(db),
    agentSessions: new PostgresAgentSessionRepository(db),
    agentSessionDigests: new PostgresAgentSessionDigestRepository(db),
    providerSessions: new PostgresProviderSessionRepository(db),
    agentSessionSummaries: new PostgresAgentSessionSummaryRepository(db),
    agentRuns: new PostgresAgentRunRepository(db),
    runtimeEvents: new PostgresRuntimeEventRepository(db),
    tools: new PostgresToolCatalogRepository(db),
    skills: new PostgresSkillCatalogRepository(db),
    capabilitySecrets: new PostgresCapabilitySecretRepository(db),
    mcpServers: new PostgresMcpServerRepository(db),
    permissions: new PostgresPermissionRepository(db),
    sandboxes: new PostgresSandboxRepository(db),
    outboundDeliveries: new PostgresOutboundDeliveryRepository(db),
  };
}
