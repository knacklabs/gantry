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
  ConversationInstall,
  ConversationApprover,
  ProviderAccount,
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
  ModelCredentialRepository,
  ProviderAccountRepository,
  ConversationRepository,
  MessageRepository,
  McpServerRepository,
  PendingAccessRequestsRepository,
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
import { assertSafeExecutionProviderId } from '../../../../domain/sessions/execution-provider-id.js';
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
import { PostgresModelCredentialRepository } from './model-credential-repository.postgres.js';
import { PostgresPendingAccessRequestsRepository } from './pending-access-request-repository.postgres.js';
import { PostgresWorkerCoordinationRepository } from './worker-coordination-repository.postgres.js';
import type { WorkerCoordinationRepository } from '../../../../domain/ports/worker-coordination.js';
import { PostgresLiveTurnRepository } from './live-turn-repository.postgres.js';
import type {
  LiveTurnCommandNotifier,
  LiveTurnCoordinationRepository,
} from '../../../../domain/ports/live-turns.js';
import { PostgresRuntimeDependencyRepository } from './runtime-dependency-repository.postgres.js';
import { PostgresSettingsRevisionRepository } from './settings-revision-repository.postgres.js';
import { PostgresAsyncTaskRepository } from './async-task-repository.postgres.js';
import { PostgresPatternCandidateRepository } from './pattern-candidate-repository.postgres.js';
import { PostgresProactiveSurfacingRepository } from './proactive-surfacing-repository.postgres.js';
import type {
  RuntimeDependencyRepository,
  SettingsRevisionRepository,
  StaleRuntimeDependencyLister,
} from '../../../../domain/ports/fleet-capability-state.js';
import type { AsyncTaskRepository } from '../../../../domain/ports/async-tasks.js';
import type { PatternCandidateRepository } from '../../../../domain/ports/pattern-candidates.js';
import type { PermissionPromotionRepository } from '../../../../domain/ports/permission-promotion.js';
import { PostgresPermissionPromotionRepository } from './permission-promotion-repository.postgres.js';
export interface PostgresDomainRepositoryBundle {
  apps: AppRepository;
  agents: AgentRepository;
  agentConfigs: AgentConfigRepository;
  providerAccounts: ProviderAccountRepository;
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
  modelCredentials: ModelCredentialRepository;
  mcpServers: McpServerRepository;
  permissions: PermissionRepository;
  pendingAccessRequests: PendingAccessRequestsRepository;
  sandboxes: SandboxRepository;
  outboundDeliveries: OutboundDeliveryRepository;
  workerCoordination: WorkerCoordinationRepository;
  liveTurns: LiveTurnCoordinationRepository;
  runtimeDependencies: RuntimeDependencyRepository &
    StaleRuntimeDependencyLister;
  settingsRevisions: SettingsRevisionRepository;
  asyncTasks: AsyncTaskRepository;
  patternCandidates: PatternCandidateRepository;
  proactiveSurfacing: PostgresProactiveSurfacingRepository;
  permissionPromotions: PermissionPromotionRepository;
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
  // Drizzle wraps the pg error (the SQLSTATE lives on the cause chain), so
  // walk causes like file-artifact-repository's sqlStateCode does.
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object') return false;
    const code = (current as { code?: unknown }).code;
    if (code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
function parseJsonArray<T extends string>(value: unknown): T[] {
  const parsed = parseJson<unknown>(value, []);
  return Array.isArray(parsed)
    ? (parsed.filter((v) => typeof v === 'string') as T[])
    : [];
}
export function parseRuntimeSecretRefsJson(
  value: unknown,
  providerId: string,
): Record<string, string> {
  const parsed =
    typeof value === 'string'
      ? value.length > 0
        ? JSON.parse(value)
        : {}
      : (value ?? {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `provider account ${providerId} runtimeSecretRefs must be a JSON object keyed by credential name`,
    );
  }
  const refs: Record<string, string> = {};
  for (const [key, ref] of Object.entries(parsed)) {
    if (typeof ref !== 'string') {
      throw new Error(
        `provider account ${providerId} runtimeSecretRefs.${key} must be a string ref`,
      );
    }
    refs[key] = ref;
  }
  return refs;
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

// Real approver IDs cannot be empty, so this row durably records a clear.
const AUTHORITATIVE_EMPTY_APPROVER = '';

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
export class PostgresProviderAccountRepository implements ProviderAccountRepository {
  constructor(private readonly db: CanonicalDb) {}
  async listProviderAccounts(
    appId: ProviderAccount['appId'],
  ): Promise<ProviderAccount[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.providerAccountsPostgres)
      .where(eq(pgSchema.providerAccountsPostgres.appId, appId))
      .orderBy(asc(pgSchema.providerAccountsPostgres.createdAt));
    return rows.map((row) => this.providerAccountFromRow(row));
  }
  async getProviderAccount(
    id: ProviderAccount['id'],
  ): Promise<ProviderAccount | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.providerAccountsPostgres)
      .where(eq(pgSchema.providerAccountsPostgres.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return this.providerAccountFromRow(row);
  }
  private providerAccountFromRow(
    row: typeof pgSchema.providerAccountsPostgres.$inferSelect,
  ): ProviderAccount {
    return {
      id: row.id,
      appId: row.appId,
      agentId: row.agentId,
      providerId: row.providerId as ProviderId,
      externalIdentityRef: externalRef(
        row.externalIdentityRefJson,
        'provider_account',
      ),
      label: row.label,
      status: row.status as ProviderAccount['status'],
      config: parseJson<Record<string, unknown>>(row.configJson, {}),
      runtimeSecretRefs: parseRuntimeSecretRefsJson(
        row.runtimeSecretRefsJson,
        row.providerId,
      ),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as unknown as ProviderAccount;
  }
  async saveProviderAccount(providerAccount: ProviderAccount): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(pgSchema.providersPostgres)
        .values({
          id: providerAccount.providerId,
          displayName: providerAccount.providerId,
        })
        .onConflictDoNothing();
      await tx
        .insert(pgSchema.providerAccountsPostgres)
        .values({
          id: providerAccount.id,
          appId: providerAccount.appId,
          agentId: providerAccount.agentId,
          providerId: providerAccount.providerId,
          externalIdentityRefJson: encodeJsonOrNull(
            providerAccount.externalIdentityRef,
          ),
          label: providerAccount.label,
          status: providerAccount.status,
          configJson: encodeJson(providerAccount.config ?? {}),
          runtimeSecretRefsJson: encodeJson(providerAccount.runtimeSecretRefs),
          createdAt: providerAccount.createdAt,
          updatedAt: providerAccount.updatedAt,
        })
        .onConflictDoUpdate({
          target: pgSchema.providerAccountsPostgres.id,
          set: {
            agentId: providerAccount.agentId,
            externalIdentityRefJson: encodeJsonOrNull(
              providerAccount.externalIdentityRef,
            ),
            label: providerAccount.label,
            status: providerAccount.status,
            configJson: encodeJson(providerAccount.config ?? {}),
            runtimeSecretRefsJson: encodeJson(
              providerAccount.runtimeSecretRefs,
            ),
            updatedAt: providerAccount.updatedAt,
          },
        });
    });
  }
  async updateProviderAccount(input: {
    appId: ProviderAccount['appId'];
    id: ProviderAccount['id'];
    patch: {
      externalIdentityRef?: ProviderAccount['externalIdentityRef'] | null;
      label?: string;
      status?: ProviderAccount['status'];
      config?: ProviderAccount['config'];
      runtimeSecretRefs?: ProviderAccount['runtimeSecretRefs'];
    };
    updatedAt: string;
  }): Promise<ProviderAccount | null> {
    const set: Partial<typeof pgSchema.providerAccountsPostgres.$inferInsert> =
      {
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
    if (input.patch.externalIdentityRef !== undefined) {
      set.externalIdentityRefJson = encodeJsonOrNull(
        input.patch.externalIdentityRef ?? undefined,
      );
    }
    const rows = await this.db
      .update(pgSchema.providerAccountsPostgres)
      .set(set)
      .where(
        and(
          eq(pgSchema.providerAccountsPostgres.appId, input.appId),
          eq(pgSchema.providerAccountsPostgres.id, input.id),
        ),
      )
      .returning();
    return rows[0] ? this.providerAccountFromRow(rows[0]) : null;
  }
  async disableProviderAccount(input: {
    appId: ProviderAccount['appId'];
    id: ProviderAccount['id'];
    updatedAt: string;
  }): Promise<ProviderAccount | null> {
    await this.db
      .update(pgSchema.providerAccountsPostgres)
      .set({ status: 'disabled', updatedAt: input.updatedAt })
      .where(
        and(
          eq(pgSchema.providerAccountsPostgres.appId, input.appId),
          eq(pgSchema.providerAccountsPostgres.id, input.id),
        ),
      );
    return await this.getProviderAccount(input.id);
  }
  async saveConversationInstall(binding: ConversationInstall): Promise<void> {
    await this.db
      .insert(pgSchema.conversationInstallsPostgres)
      .values({
        id: binding.id,
        appId: binding.appId,
        agentId: binding.agentId,
        providerAccountId: binding.providerAccountId,
        conversationId: binding.conversationId,
        threadId: binding.threadId ?? null,
        displayName: binding.displayName,
        status: binding.status,
        senderPolicy: binding.senderPolicy,
        controlPolicy: binding.controlPolicy,
        memoryScope: binding.memoryScope,
        memorySubjectJson: encodeJson(binding.memorySubject),
        workspaceSnapshotId: binding.workspaceSnapshotId ?? null,
        permissionPolicyIdsJson: encodeJson(binding.permissionPolicyIds),
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.conversationInstallsPostgres.id,
        set: {
          agentId: binding.agentId,
          providerAccountId: binding.providerAccountId,
          conversationId: binding.conversationId,
          threadId: binding.threadId ?? null,
          displayName: binding.displayName,
          status: binding.status,
          senderPolicy: binding.senderPolicy,
          controlPolicy: binding.controlPolicy,
          memoryScope: binding.memoryScope,
          memorySubjectJson: encodeJson(binding.memorySubject),
          workspaceSnapshotId: binding.workspaceSnapshotId ?? null,
          permissionPolicyIdsJson: encodeJson(binding.permissionPolicyIds),
          updatedAt: binding.updatedAt,
        },
      });
  }
  async disableConversationInstall(input: {
    appId: App['id'];
    agentId: Agent['id'];
    conversationId: Conversation['id'];
    threadId?: ConversationThread['id'];
    updatedAt: string;
  }): Promise<ConversationInstall | null> {
    const b = pgSchema.conversationInstallsPostgres;
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
  async getConversationInstall(input: {
    appId: App['id'];
    agentId: Agent['id'];
    conversationId: Conversation['id'];
    threadId?: ConversationThread['id'];
    exactThreadId?: boolean;
  }): Promise<ConversationInstall | null> {
    const b = pgSchema.conversationInstallsPostgres;
    const controlBindingPredicate = sql`${b.id} not like 'conversation-route:%'`;
    const threadPredicate = input.threadId
      ? input.exactThreadId
        ? eq(b.threadId, input.threadId)
        : or(eq(b.threadId, input.threadId), isNull(b.threadId))
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
    const b = await this.getConversationInstall(input);
    if (!b) return false;
    if (b.status !== 'active') return false;
    const rows = await this.db
      .select({ id: pgSchema.agentsPostgres.id })
      .from(pgSchema.agentsPostgres)
      .innerJoin(
        pgSchema.providerAccountsPostgres,
        eq(pgSchema.providerAccountsPostgres.id, b.providerAccountId),
      )
      .innerJoin(
        pgSchema.conversationsPostgres,
        eq(pgSchema.conversationsPostgres.id, b.conversationId),
      )
      .where(
        and(
          eq(pgSchema.agentsPostgres.id, b.agentId),
          eq(pgSchema.agentsPostgres.status, 'active'),
          eq(pgSchema.providerAccountsPostgres.status, 'active'),
          eq(pgSchema.conversationsPostgres.status, 'active'),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
  async listConversationInstalls(
    appId: App['id'],
    agentId?: Agent['id'],
  ): Promise<ConversationInstall[]> {
    const b = pgSchema.conversationInstallsPostgres;
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
  async listConversationInstallsByConversation(input: {
    appId: App['id'];
    conversationId: Conversation['id'];
  }): Promise<ConversationInstall[]> {
    const b = pgSchema.conversationInstallsPostgres;
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
    row: typeof pgSchema.conversationInstallsPostgres.$inferSelect,
  ): ConversationInstall {
    return {
      id: row.id,
      appId: row.appId,
      agentId: row.agentId,
      providerAccountId: row.providerAccountId,
      conversationId: row.conversationId,
      threadId: row.threadId ?? undefined,
      displayName: row.displayName,
      status: (row.status ?? 'active') as ConversationInstall['status'],
      senderPolicy: (row.senderPolicy ??
        'provider_native') as ConversationInstall['senderPolicy'],
      controlPolicy: (row.controlPolicy ??
        'conversation_approvers') as ConversationInstall['controlPolicy'],
      memoryScope: (row.memoryScope ??
        'conversation') as ConversationInstall['memoryScope'],
      memorySubject: parseJson<MemorySubject>(row.memorySubjectJson, {
        kind: 'conversation',
        appId: row.appId,
        conversationId: row.conversationId,
      } as MemorySubject),
      workspaceSnapshotId: row.workspaceSnapshotId ?? undefined,
      permissionPolicyIds: parseJsonArray(row.permissionPolicyIdsJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as ConversationInstall;
  }
}
export class PostgresConversationRepository implements ConversationRepository {
  constructor(private readonly db: CanonicalDb) {}
  async listConversations(input: {
    appId: Conversation['appId'];
    providerAccountId?: ProviderAccount['id'];
  }): Promise<Conversation[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.conversationsPostgres)
      .where(
        and(
          eq(pgSchema.conversationsPostgres.appId, input.appId),
          eq(pgSchema.conversationsPostgres.status, 'active'),
          input.providerAccountId
            ? eq(
                pgSchema.conversationsPostgres.providerAccountId,
                input.providerAccountId,
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
    providerAccountId: ProviderAccount['id'];
    externalConversationId: string;
  }): Promise<Conversation | null> {
    const c = pgSchema.conversationsPostgres;
    const ci = pgSchema.providerAccountsPostgres;
    const rows = await this.db
      .select({ conversation: c })
      .from(c)
      .innerJoin(ci, eq(ci.id, c.providerAccountId))
      .where(
        and(
          eq(c.appId, input.appId),
          eq(c.status, 'active'),
          eq(ci.providerId, input.providerId),
          eq(c.providerAccountId, input.providerAccountId),
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
    const ci = pgSchema.providerAccountsPostgres;
    const rows = await this.db
      .select({ thread: t })
      .from(t)
      .innerJoin(c, eq(c.id, t.conversationId))
      .innerJoin(ci, eq(ci.id, c.providerAccountId))
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
        providerAccountId: conversation.providerAccountId,
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
          providerAccountId: conversation.providerAccountId,
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
    return (await this.listConversationApproverRows([conversationId])).filter(
      (approver) => approver.externalUserId !== AUTHORITATIVE_EMPTY_APPROVER,
    );
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
      await tx.insert(pgSchema.conversationApproversPostgres).values(
        (input.externalUserIds.length
          ? input.externalUserIds
          : [AUTHORITATIVE_EMPTY_APPROVER]
        ).map((externalUserId) => ({
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
      providerAccountId: row.providerAccountId,
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
      const ci = pgSchema.providerAccountsPostgres;
      const channelRows = await tx
        .select({
          providerAccountId: c.providerAccountId,
          providerId: ci.providerId,
        })
        .from(c)
        .innerJoin(ci, eq(ci.id, c.providerAccountId))
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
                pgSchema.messagesPostgres.providerAccountId,
                channel.providerAccountId,
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
          providerAccountId: channel.providerAccountId,
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
    assertSafeExecutionProviderId(run.executionProviderId);
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
        executionProviderId: run.executionProviderId,
        providerRunId: run.providerRunId ?? null,
        providerSessionId: run.providerSessionId ?? null,
        workerId: run.workerId ?? null,
        leaseOwner: run.leaseOwner ?? null,
        leaseExpiresAt: run.leaseExpiresAt ?? null,
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
          executionProviderId: run.executionProviderId,
          providerRunId: run.providerRunId ?? null,
          providerSessionId: run.providerSessionId ?? null,
          workerId: run.workerId ?? null,
          leaseOwner: run.leaseOwner ?? null,
          leaseExpiresAt: run.leaseExpiresAt ?? null,
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
      executionProviderId: row.executionProviderId as never,
      providerRunId: row.providerRunId ?? undefined,
      providerSessionId: row.providerSessionId ?? undefined,
      workerId: row.workerId ?? undefined,
      leaseOwner: row.leaseOwner ?? undefined,
      leaseExpiresAt: row.leaseExpiresAt
        ? toIsoTimestamp(row.leaseExpiresAt)
        : undefined,
      permissionDecisionIds: parseJsonArray(row.permissionDecisionIdsJson),
      sandboxLeaseId: row.sandboxLeaseId ?? undefined,
      workspaceSnapshotId: row.workspaceSnapshotId ?? undefined,
      cause: row.cause as AgentRun['cause'],
      status: row.status as AgentRun['status'],
      createdAt: toIsoTimestamp(row.createdAt),
      startedAt: row.startedAt ? toIsoTimestamp(row.startedAt) : undefined,
      endedAt: row.endedAt ? toIsoTimestamp(row.endedAt) : undefined,
      resultSummary: row.resultSummary ?? undefined,
      errorSummary: row.errorSummary ?? undefined,
    } as unknown as AgentRun;
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
  options: { liveTurnCommandNotifier?: LiveTurnCommandNotifier } = {},
): PostgresDomainRepositoryBundle {
  return {
    apps: new PostgresAppRepository(db),
    agents: new PostgresAgentRepository(db),
    agentConfigs: new PostgresAgentConfigRepository(db),
    providerAccounts: new PostgresProviderAccountRepository(db),
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
    modelCredentials: new PostgresModelCredentialRepository(db),
    mcpServers: new PostgresMcpServerRepository(db),
    permissions: new PostgresPermissionRepository(db),
    pendingAccessRequests: new PostgresPendingAccessRequestsRepository(db),
    sandboxes: new PostgresSandboxRepository(db),
    outboundDeliveries: new PostgresOutboundDeliveryRepository(db),
    workerCoordination: new PostgresWorkerCoordinationRepository(
      db,
      options.liveTurnCommandNotifier,
    ),
    liveTurns: new PostgresLiveTurnRepository(
      db,
      options.liveTurnCommandNotifier,
    ),
    runtimeDependencies: new PostgresRuntimeDependencyRepository(db),
    settingsRevisions: new PostgresSettingsRevisionRepository(db),
    asyncTasks: new PostgresAsyncTaskRepository(db),
    patternCandidates: new PostgresPatternCandidateRepository(db),
    proactiveSurfacing: new PostgresProactiveSurfacingRepository(db),
    permissionPromotions: new PostgresPermissionPromotionRepository(db),
  };
}
