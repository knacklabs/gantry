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

import type {
  Agent,
  AgentConfigVersion,
  LlmProfileId,
} from '../../../../domain/agent/agent.js';
import type { App } from '../../../../domain/app/app.js';
import type { BrowserProfile } from '../../../../domain/browser/browser.js';
import type {
  AgentChannelBinding,
  ChannelInstallation,
  ChannelProviderId,
} from '../../../../domain/channel/channel.js';
import type {
  Conversation,
  ConversationThread,
} from '../../../../domain/conversation/conversation.js';
import type { AgentRun } from '../../../../domain/events/events.js';
import type { Job, JobTrigger } from '../../../../domain/jobs/jobs.js';
import type {
  MemoryItem,
  MemorySubject,
} from '../../../../domain/memory/memory.js';
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
  AgentSessionRepository,
  AgentSessionSummaryRepository,
  AppRepository,
  BrowserProfileRepository,
  ChannelInstallationRepository,
  ConversationRepository,
  JobRepository,
  MemoryRepository,
  MessageRepository,
  McpServerRepository,
  PermissionRepository,
  ProviderSessionRepository,
  RuntimeEventRepository,
  SandboxRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../../../domain/ports/repositories.js';
import type {
  SandboxLease,
  SandboxProfile,
  WorkspaceSnapshot,
} from '../../../../domain/sandbox/sandbox.js';
import type { AgentSession } from '../../../../domain/sessions/sessions.js';
import type { ToolCatalogItem } from '../../../../domain/tools/tools.js';
import type { ExternalRef } from '../../../../shared/ids/branded-id.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import {
  PostgresAgentSessionRepository,
  PostgresAgentSessionSummaryRepository,
  PostgresProviderSessionRepository,
} from './session-repositories.postgres.js';
import { PostgresMcpServerRepository } from './mcp-server-repository.postgres.js';
import { PostgresSkillCatalogRepository } from './skill-repository.postgres.js';
import { PostgresRuntimeEventRepository } from './runtime-event-repository.postgres.js';

export interface PostgresDomainRepositoryBundle {
  apps: AppRepository;
  agents: AgentRepository;
  agentConfigs: AgentConfigRepository;
  channelInstallations: ChannelInstallationRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  agentSessions: AgentSessionRepository;
  providerSessions: ProviderSessionRepository;
  agentSessionSummaries: AgentSessionSummaryRepository;
  agentRuns: AgentRunRepository;
  runtimeEvents: RuntimeEventRepository;
  memory: MemoryRepository;
  jobs: JobRepository;
  tools: ToolCatalogRepository;
  skills: SkillCatalogRepository;
  mcpServers: McpServerRepository;
  permissions: PermissionRepository;
  sandboxes: SandboxRepository;
  browserProfiles: BrowserProfileRepository;
}

type JsonRecord = Record<string, unknown>;

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function encodeJsonOrNull(value: unknown | undefined): string | null {
  return value === undefined ? null : encodeJson(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    if (!(err instanceof SyntaxError)) {
      throw err;
    }
    return fallback;
  }
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

function toMemorySubjectFields(subject: MemorySubject): {
  subjectType: string;
  subjectId: string;
  userId: string | null;
  conversationId: string | null;
  threadId: string | null;
} {
  switch (subject.kind) {
    case 'app':
      return {
        subjectType: 'app',
        subjectId: subject.appId,
        userId: null,
        conversationId: null,
        threadId: null,
      };
    case 'agent':
      return {
        subjectType: 'agent',
        subjectId: subject.agentId,
        userId: null,
        conversationId: null,
        threadId: null,
      };
    case 'user':
      return {
        subjectType: 'user',
        subjectId: subject.userId,
        userId: subject.userId,
        conversationId: null,
        threadId: null,
      };
    case 'conversation':
      return {
        subjectType: 'conversation',
        subjectId: subject.conversationId,
        userId: null,
        conversationId: subject.conversationId,
        threadId: null,
      };
    case 'thread':
      return {
        subjectType: 'thread',
        subjectId: subject.threadId,
        userId: null,
        conversationId: subject.conversationId,
        threadId: subject.threadId,
      };
  }
}

function memorySubjectFromRow(row: {
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

function messagePartToPayload(part: MessagePart): string {
  switch (part.kind) {
    case 'text':
      return encodeJson({ text: part.text });
    case 'markdown':
      return encodeJson({ markdown: part.markdown });
    case 'code':
      return encodeJson({ language: part.language, code: part.code });
    case 'structured':
      return encodeJson({ value: part.value });
    case 'tool_result':
      return encodeJson({ toolId: part.toolId, value: part.value });
    case 'redacted':
      return encodeJson({ reason: part.reason });
  }
}

function payloadToMessagePart(kind: string, payloadJson: string): MessagePart {
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

export class PostgresAgentRepository implements AgentRepository {
  constructor(private readonly db: CanonicalDb) {}

  async getAgent(id: Agent['id']): Promise<Agent | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentsPostgres)
      .where(eq(pgSchema.agentsPostgres.id, id))
      .limit(1);
    return (rows[0] as Agent | undefined) ?? null;
  }

  async listAgents(appId: App['id']): Promise<Agent[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentsPostgres)
      .where(eq(pgSchema.agentsPostgres.appId, appId))
      .orderBy(
        asc(pgSchema.agentsPostgres.name),
        asc(pgSchema.agentsPostgres.id),
      );
    return rows as Agent[];
  }

  async saveAgent(agent: Agent): Promise<void> {
    await this.db
      .insert(pgSchema.agentsPostgres)
      .values({
        ...agent,
        currentConfigVersionId: agent.currentConfigVersionId ?? null,
      })
      .onConflictDoUpdate({
        target: pgSchema.agentsPostgres.id,
        set: {
          name: agent.name,
          status: agent.status,
          currentConfigVersionId: agent.currentConfigVersionId ?? null,
          updatedAt: agent.updatedAt,
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

export class PostgresChannelInstallationRepository implements ChannelInstallationRepository {
  constructor(private readonly db: CanonicalDb) {}

  async listChannelInstallations(
    appId: ChannelInstallation['appId'],
  ): Promise<ChannelInstallation[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.channelInstallationsPostgres)
      .where(eq(pgSchema.channelInstallationsPostgres.appId, appId))
      .orderBy(asc(pgSchema.channelInstallationsPostgres.createdAt));
    return rows.map((row) => this.installationFromRow(row));
  }

  async getChannelInstallation(
    id: ChannelInstallation['id'],
  ): Promise<ChannelInstallation | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.channelInstallationsPostgres)
      .where(eq(pgSchema.channelInstallationsPostgres.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return this.installationFromRow(row);
  }

  private installationFromRow(
    row: typeof pgSchema.channelInstallationsPostgres.$inferSelect,
  ): ChannelInstallation {
    return {
      id: row.id,
      appId: row.appId,
      providerId: row.providerId as ChannelProviderId,
      externalInstallationRef: externalRef(
        row.externalRefJson,
        'channel_installation',
      ),
      label: row.label,
      status: row.status as ChannelInstallation['status'],
      config: parseJson<Record<string, unknown>>(row.configJson, {}),
      runtimeSecretRefs: parseJsonArray(row.runtimeSecretRefsJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as unknown as ChannelInstallation;
  }

  async saveChannelInstallation(
    installation: ChannelInstallation,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(pgSchema.channelProvidersPostgres)
        .values({
          id: installation.providerId,
          displayName: installation.providerId,
        })
        .onConflictDoNothing();
      await tx
        .insert(pgSchema.channelInstallationsPostgres)
        .values({
          id: installation.id,
          appId: installation.appId,
          providerId: installation.providerId,
          externalRefJson: encodeJsonOrNull(
            installation.externalInstallationRef,
          ),
          label: installation.label,
          status: installation.status,
          configJson: encodeJson(installation.config ?? {}),
          runtimeSecretRefsJson: encodeJson(installation.runtimeSecretRefs),
          createdAt: installation.createdAt,
          updatedAt: installation.updatedAt,
        })
        .onConflictDoUpdate({
          target: pgSchema.channelInstallationsPostgres.id,
          set: {
            externalRefJson: encodeJsonOrNull(
              installation.externalInstallationRef,
            ),
            label: installation.label,
            status: installation.status,
            configJson: encodeJson(installation.config ?? {}),
            runtimeSecretRefsJson: encodeJson(installation.runtimeSecretRefs),
            updatedAt: installation.updatedAt,
          },
        });
    });
  }

  async updateChannelInstallation(input: {
    appId: ChannelInstallation['appId'];
    id: ChannelInstallation['id'];
    patch: {
      externalInstallationRef?:
        | ChannelInstallation['externalInstallationRef']
        | null;
      label?: string;
      status?: ChannelInstallation['status'];
      config?: ChannelInstallation['config'];
      runtimeSecretRefs?: ChannelInstallation['runtimeSecretRefs'];
    };
    updatedAt: string;
  }): Promise<ChannelInstallation | null> {
    const set: Partial<
      typeof pgSchema.channelInstallationsPostgres.$inferInsert
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
      .update(pgSchema.channelInstallationsPostgres)
      .set(set)
      .where(
        and(
          eq(pgSchema.channelInstallationsPostgres.appId, input.appId),
          eq(pgSchema.channelInstallationsPostgres.id, input.id),
        ),
      )
      .returning();
    return rows[0] ? this.installationFromRow(rows[0]) : null;
  }

  async disableChannelInstallation(input: {
    appId: ChannelInstallation['appId'];
    id: ChannelInstallation['id'];
    updatedAt: string;
  }): Promise<ChannelInstallation | null> {
    await this.db
      .update(pgSchema.channelInstallationsPostgres)
      .set({ status: 'disabled', updatedAt: input.updatedAt })
      .where(
        and(
          eq(pgSchema.channelInstallationsPostgres.appId, input.appId),
          eq(pgSchema.channelInstallationsPostgres.id, input.id),
        ),
      );
    return await this.getChannelInstallation(input.id);
  }

  async saveAgentChannelBinding(binding: AgentChannelBinding): Promise<void> {
    await this.db
      .insert(pgSchema.agentChannelBindingsPostgres)
      .values({
        id: binding.id,
        appId: binding.appId,
        agentId: binding.agentId,
        channelInstallationId: binding.channelInstallationId,
        conversationId: binding.conversationId,
        threadId: binding.threadId ?? null,
        displayName: binding.displayName,
        status: binding.status,
        triggerMode: binding.triggerMode,
        triggerPattern: binding.triggerPattern ?? null,
        requiresTrigger: binding.requiresTrigger,
        isAdminBinding: binding.isAdminBinding,
        memoryScope: binding.memoryScope,
        memorySubjectJson: encodeJson(binding.memorySubject),
        workspaceSnapshotId: binding.workspaceSnapshotId ?? null,
        permissionPolicyIdsJson: encodeJson(binding.permissionPolicyIds),
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.agentChannelBindingsPostgres.id,
        set: {
          displayName: binding.displayName,
          status: binding.status,
          triggerMode: binding.triggerMode,
          triggerPattern: binding.triggerPattern ?? null,
          requiresTrigger: binding.requiresTrigger,
          isAdminBinding: binding.isAdminBinding,
          memoryScope: binding.memoryScope,
          memorySubjectJson: encodeJson(binding.memorySubject),
          workspaceSnapshotId: binding.workspaceSnapshotId ?? null,
          permissionPolicyIdsJson: encodeJson(binding.permissionPolicyIds),
          updatedAt: binding.updatedAt,
        },
      });
  }

  async disableAgentChannelBinding(input: {
    appId: App['id'];
    agentId: Agent['id'];
    conversationId: Conversation['id'];
    threadId?: ConversationThread['id'];
    updatedAt: string;
  }): Promise<AgentChannelBinding | null> {
    const b = pgSchema.agentChannelBindingsPostgres;
    const rows = await this.db
      .update(b)
      .set({ status: 'disabled', updatedAt: input.updatedAt })
      .where(
        and(
          eq(b.appId, input.appId),
          eq(b.agentId, input.agentId),
          eq(b.conversationId, input.conversationId),
          input.threadId ? eq(b.threadId, input.threadId) : isNull(b.threadId),
        ),
      )
      .returning();
    return rows[0] ? this.bindingFromRow(rows[0]) : null;
  }

  async getAgentChannelBinding(input: {
    appId: App['id'];
    agentId: Agent['id'];
    conversationId: Conversation['id'];
    threadId?: ConversationThread['id'];
  }): Promise<AgentChannelBinding | null> {
    const b = pgSchema.agentChannelBindingsPostgres;
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
    const b = await this.getAgentChannelBinding(input);
    if (!b) return false;
    if (b.status !== 'active') return false;
    const rows = await this.db
      .select({ id: pgSchema.agentsPostgres.id })
      .from(pgSchema.agentsPostgres)
      .innerJoin(
        pgSchema.channelInstallationsPostgres,
        eq(pgSchema.channelInstallationsPostgres.id, b.channelInstallationId),
      )
      .innerJoin(
        pgSchema.conversationsPostgres,
        eq(pgSchema.conversationsPostgres.id, b.conversationId),
      )
      .where(
        and(
          eq(pgSchema.agentsPostgres.id, b.agentId),
          eq(pgSchema.agentsPostgres.status, 'active'),
          eq(pgSchema.channelInstallationsPostgres.status, 'active'),
          eq(pgSchema.conversationsPostgres.status, 'active'),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async listAgentChannelBindings(
    appId: App['id'],
    agentId?: Agent['id'],
  ): Promise<AgentChannelBinding[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentChannelBindingsPostgres)
      .where(
        and(
          eq(pgSchema.agentChannelBindingsPostgres.appId, appId),
          agentId
            ? eq(pgSchema.agentChannelBindingsPostgres.agentId, agentId)
            : undefined,
        ),
      )
      .orderBy(asc(pgSchema.agentChannelBindingsPostgres.createdAt));
    return rows.map((row) => this.bindingFromRow(row));
  }

  private bindingFromRow(
    row: typeof pgSchema.agentChannelBindingsPostgres.$inferSelect,
  ): AgentChannelBinding {
    return {
      id: row.id,
      appId: row.appId,
      agentId: row.agentId,
      channelInstallationId: row.channelInstallationId,
      conversationId: row.conversationId,
      threadId: row.threadId ?? undefined,
      displayName: row.displayName,
      status: (row.status ?? 'active') as AgentChannelBinding['status'],
      triggerMode: (row.triggerMode ??
        (row.requiresTrigger
          ? 'keyword'
          : 'always')) as AgentChannelBinding['triggerMode'],
      triggerPattern: row.triggerPattern ?? undefined,
      requiresTrigger: row.requiresTrigger,
      isAdminBinding: row.isAdminBinding,
      memoryScope: (row.memoryScope ??
        'conversation') as AgentChannelBinding['memoryScope'],
      memorySubject: parseJson<MemorySubject>(row.memorySubjectJson, {
        kind: 'conversation',
        appId: row.appId,
        conversationId: row.conversationId,
      } as MemorySubject),
      workspaceSnapshotId: row.workspaceSnapshotId ?? undefined,
      permissionPolicyIds: parseJsonArray(row.permissionPolicyIdsJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as AgentChannelBinding;
  }
}

export class PostgresConversationRepository implements ConversationRepository {
  constructor(private readonly db: CanonicalDb) {}

  async listConversations(input: {
    appId: Conversation['appId'];
    channelInstallationId?: ChannelInstallation['id'];
  }): Promise<Conversation[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.conversationsPostgres)
      .where(
        and(
          eq(pgSchema.conversationsPostgres.appId, input.appId),
          input.channelInstallationId
            ? eq(
                pgSchema.conversationsPostgres.channelInstallationId,
                input.channelInstallationId,
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
    providerId: ChannelProviderId;
    channelInstallationId: ChannelInstallation['id'];
    externalConversationId: string;
  }): Promise<Conversation | null> {
    const c = pgSchema.conversationsPostgres;
    const ci = pgSchema.channelInstallationsPostgres;
    const rows = await this.db
      .select({ conversation: c })
      .from(c)
      .innerJoin(ci, eq(ci.id, c.channelInstallationId))
      .where(
        and(
          eq(c.appId, input.appId),
          eq(ci.providerId, input.providerId),
          eq(c.channelInstallationId, input.channelInstallationId),
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
    providerId: ChannelProviderId;
    conversationId: Conversation['id'];
    externalThreadId: string;
  }): Promise<ConversationThread | null> {
    const t = pgSchema.conversationThreadsPostgres;
    const c = pgSchema.conversationsPostgres;
    const ci = pgSchema.channelInstallationsPostgres;
    const rows = await this.db
      .select({ thread: t })
      .from(t)
      .innerJoin(c, eq(c.id, t.conversationId))
      .innerJoin(ci, eq(ci.id, c.channelInstallationId))
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
        channelInstallationId: conversation.channelInstallationId,
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

  private conversationFromRow(
    row: typeof pgSchema.conversationsPostgres.$inferSelect,
  ): Conversation {
    return {
      id: row.id,
      appId: row.appId,
      channelInstallationId: row.channelInstallationId,
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
      const ci = pgSchema.channelInstallationsPostgres;
      const channelRows = await tx
        .select({
          channelInstallationId: c.channelInstallationId,
          providerId: ci.providerId,
        })
        .from(c)
        .innerJoin(ci, eq(ci.id, c.channelInstallationId))
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
              eq(pgSchema.messagesPostgres.channelProvider, channel.providerId),
              eq(
                pgSchema.messagesPostgres.channelInstallationId,
                channel.channelInstallationId,
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
          channelProvider: channel.providerId,
          channelInstallationId: channel.channelInstallationId,
          conversationId: message.conversationId,
          threadId: message.threadId ?? null,
          externalMessageId,
          externalRefJson: encodeJsonOrNull(message.externalRef),
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
            externalRefJson: encodeJsonOrNull(message.externalRef),
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
            payloadJson: messagePartToPayload(part),
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
            externalRefJson: encodeJsonOrNull(attachment.externalRef),
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
      createdAt: row.createdAt,
      receivedAt: row.receivedAt ?? undefined,
      deliveryStatus: row.deliveryStatus ?? undefined,
      deliveredAt: row.deliveredAt ?? undefined,
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

export class PostgresMemoryRepository implements MemoryRepository {
  constructor(private readonly db: CanonicalDb) {}

  async getMemoryItem(id: MemoryItem['id']): Promise<MemoryItem | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.memoryItemsPostgres)
      .where(eq(pgSchema.memoryItemsPostgres.id, id))
      .limit(1);
    return rows[0] ? this.memoryFromRow(rows[0]) : null;
  }

  async saveMemoryItem(item: MemoryItem): Promise<void> {
    const fields = toMemorySubjectFields(item.subject);
    await this.db
      .insert(pgSchema.memoryItemsPostgres)
      .values({
        id: item.id,
        appId: item.appId,
        agentId:
          item.agentId ??
          (item.subject.kind === 'agent' ? item.subject.agentId : null),
        subjectType: fields.subjectType,
        subjectId: fields.subjectId,
        userId: fields.userId,
        conversationId: fields.conversationId,
        threadId: fields.threadId,
        kind: item.kind,
        key: item.key,
        valueJson: encodeJson({ value: item.value }),
        confidence: item.confidence,
        sourceRefJson: encodeJson({
          source: item.source,
          isPinned: item.isPinned,
        }),
        status: item.isDeleted ? 'deleted' : 'active',
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.memoryItemsPostgres.id,
        set: {
          valueJson: encodeJson({ value: item.value }),
          confidence: item.confidence,
          sourceRefJson: encodeJson({
            source: item.source,
            isPinned: item.isPinned,
          }),
          status: item.isDeleted ? 'deleted' : 'active',
          updatedAt: item.updatedAt,
        },
      });
  }

  async listMemoryItems(
    subject: MemorySubject,
    limit = 100,
  ): Promise<MemoryItem[]> {
    const fields = toMemorySubjectFields(subject);
    const rows = await this.db
      .select()
      .from(pgSchema.memoryItemsPostgres)
      .where(
        and(
          eq(pgSchema.memoryItemsPostgres.appId, subject.appId),
          eq(pgSchema.memoryItemsPostgres.subjectType, fields.subjectType),
          eq(pgSchema.memoryItemsPostgres.subjectId, fields.subjectId),
        ),
      )
      .orderBy(desc(pgSchema.memoryItemsPostgres.updatedAt))
      .limit(limit);
    return rows.map((row) => this.memoryFromRow(row));
  }

  private memoryFromRow(
    row: typeof pgSchema.memoryItemsPostgres.$inferSelect,
  ): MemoryItem {
    const source = parseJson<{ source?: string; isPinned?: boolean }>(
      row.sourceRefJson,
      {},
    );
    const value = parseJson<{ value?: string }>(row.valueJson, {});
    return {
      id: row.id,
      appId: row.appId,
      agentId: row.agentId ?? undefined,
      subject: memorySubjectFromRow(row),
      kind: row.kind as MemoryItem['kind'],
      key: row.key,
      value: String(value.value ?? ''),
      source: source.source ?? '',
      confidence: row.confidence,
      isPinned: Boolean(source.isPinned),
      isDeleted: row.status === 'deleted',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as MemoryItem;
  }
}

export class PostgresJobRepository implements JobRepository {
  constructor(private readonly db: CanonicalDb) {}

  async getJob(id: Job['id']): Promise<Job | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.canonicalJobsPostgres)
      .where(eq(pgSchema.canonicalJobsPostgres.id, id))
      .limit(1);
    return rows[0] ? this.jobFromRow(rows[0]) : null;
  }

  async saveJob(job: Job): Promise<void> {
    await this.db
      .insert(pgSchema.canonicalJobsPostgres)
      .values({
        id: job.id,
        appId: job.appId,
        agentId: job.agentId,
        conversationId: job.target?.conversationId ?? null,
        threadId: job.target?.threadId ?? null,
        createdByActorId: job.target?.userId ?? 'runtime',
        createdBySource: 'repository',
        name: job.name,
        prompt: job.prompt,
        modelOverride: job.modelOverride ?? null,
        scheduleJson: encodeJson(job.schedule),
        status: job.status,
        executionMode: job.executionMode,
        targetJson: encodeJson(job.target ?? {}),
        silent: job.silent,
        timeoutMs: job.timeoutMs,
        maxRetries: job.maxRetries,
        retryBackoffMs: job.retryBackoffMs,
        nextRunAt: job.nextRunAt ?? null,
        lastRunAt: job.lastRunAt ?? null,
        leaseRunId: job.leaseRunId ?? null,
        leaseExpiresAt: job.leaseExpiresAt ?? null,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.canonicalJobsPostgres.id,
        set: {
          name: job.name,
          prompt: job.prompt,
          modelOverride: job.modelOverride ?? null,
          scheduleJson: encodeJson(job.schedule),
          status: job.status,
          executionMode: job.executionMode,
          targetJson: encodeJson(job.target ?? {}),
          silent: job.silent,
          timeoutMs: job.timeoutMs,
          maxRetries: job.maxRetries,
          retryBackoffMs: job.retryBackoffMs,
          nextRunAt: job.nextRunAt ?? null,
          lastRunAt: job.lastRunAt ?? null,
          leaseRunId: job.leaseRunId ?? null,
          leaseExpiresAt: job.leaseExpiresAt ?? null,
          updatedAt: job.updatedAt,
        },
      });
  }

  async listJobs(appId: App['id']): Promise<Job[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.canonicalJobsPostgres)
      .where(eq(pgSchema.canonicalJobsPostgres.appId, appId))
      .orderBy(desc(pgSchema.canonicalJobsPostgres.updatedAt));
    return rows.map((row) => this.jobFromRow(row));
  }

  async saveJobTrigger(trigger: JobTrigger): Promise<void> {
    await this.db
      .insert(pgSchema.canonicalJobTriggersPostgres)
      .values({
        id: trigger.id,
        appId: trigger.appId,
        jobId: trigger.jobId,
        runId: trigger.runId ?? null,
        requestedBy: trigger.requestedBy,
        requestedAt: trigger.requestedAt,
        status: trigger.status,
        createdAt: trigger.createdAt,
        updatedAt: trigger.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.canonicalJobTriggersPostgres.id,
        set: {
          runId: trigger.runId ?? null,
          status: trigger.status,
          updatedAt: trigger.updatedAt,
        },
      });
  }

  private jobFromRow(
    row: typeof pgSchema.canonicalJobsPostgres.$inferSelect,
  ): Job {
    return {
      id: row.id,
      appId: row.appId,
      agentId: row.agentId ?? '',
      name: row.name,
      prompt: row.prompt,
      modelOverride: row.modelOverride ?? undefined,
      schedule: parseJson<Job['schedule']>(row.scheduleJson, {
        kind: 'manual',
      }),
      status: row.status as Job['status'],
      executionMode: row.executionMode as Job['executionMode'],
      target: parseJson<Job['target']>(row.targetJson, undefined),
      silent: row.silent,
      timeoutMs: row.timeoutMs,
      maxRetries: row.maxRetries,
      retryBackoffMs: row.retryBackoffMs,
      nextRunAt: row.nextRunAt ?? undefined,
      lastRunAt: row.lastRunAt ?? undefined,
      leaseRunId: row.leaseRunId ?? undefined,
      leaseExpiresAt: row.leaseExpiresAt ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as Job;
  }
}

export class PostgresToolCatalogRepository implements ToolCatalogRepository {
  constructor(private readonly db: CanonicalDb) {}

  async getTool(id: ToolCatalogItem['id']): Promise<ToolCatalogItem | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.toolCatalogPostgres)
      .where(eq(pgSchema.toolCatalogPostgres.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      appId: row.appId,
      name: row.name,
      description: row.description ?? undefined,
      inputSchema: parseJson(row.inputSchemaJson, undefined),
      outputSchema: parseJson(row.outputSchemaJson, undefined),
      risk: row.risk as ToolCatalogItem['risk'],
      permissionPolicyId: row.permissionPolicyId ?? undefined,
      sandboxProfileId: row.sandboxProfileId ?? undefined,
      adapterRef: row.adapterRef,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as ToolCatalogItem;
  }

  async saveTool(item: ToolCatalogItem): Promise<void> {
    await this.db
      .insert(pgSchema.toolCatalogPostgres)
      .values({
        id: item.id,
        appId: item.appId,
        name: item.name,
        description: item.description ?? null,
        inputSchemaJson: encodeJson(item.inputSchema ?? {}),
        outputSchemaJson: encodeJson(item.outputSchema ?? {}),
        risk: item.risk,
        permissionPolicyId: item.permissionPolicyId ?? null,
        sandboxProfileId: item.sandboxProfileId ?? null,
        adapterRef: item.adapterRef,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.toolCatalogPostgres.id,
        set: {
          name: item.name,
          description: item.description ?? null,
          inputSchemaJson: encodeJson(item.inputSchema ?? {}),
          outputSchemaJson: encodeJson(item.outputSchema ?? {}),
          risk: item.risk,
          permissionPolicyId: item.permissionPolicyId ?? null,
          sandboxProfileId: item.sandboxProfileId ?? null,
          adapterRef: item.adapterRef,
          updatedAt: item.updatedAt,
        },
      });
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

export class PostgresBrowserProfileRepository implements BrowserProfileRepository {
  constructor(private readonly db: CanonicalDb) {}

  async getBrowserProfile(
    id: BrowserProfile['id'],
  ): Promise<BrowserProfile | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.browserProfilesPostgres)
      .where(eq(pgSchema.browserProfilesPostgres.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      appId: row.appId,
      agentId: row.agentId ?? undefined,
      label: row.label,
      storageStateRef: row.storageStateRef ?? undefined,
      authMarkers: parseJsonArray(row.authMarkersJson),
      permissionPolicyId: row.permissionPolicyId ?? undefined,
      status: row.status as BrowserProfile['status'],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as BrowserProfile;
  }

  async saveBrowserProfile(profile: BrowserProfile): Promise<void> {
    await this.db
      .insert(pgSchema.browserProfilesPostgres)
      .values({
        id: profile.id,
        appId: profile.appId,
        agentId: profile.agentId ?? null,
        label: profile.label,
        storageStateRef: profile.storageStateRef ?? null,
        authMarkersJson: encodeJson(profile.authMarkers),
        permissionPolicyId: profile.permissionPolicyId ?? null,
        status: profile.status,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.browserProfilesPostgres.id,
        set: {
          label: profile.label,
          storageStateRef: profile.storageStateRef ?? null,
          authMarkersJson: encodeJson(profile.authMarkers),
          permissionPolicyId: profile.permissionPolicyId ?? null,
          status: profile.status,
          updatedAt: profile.updatedAt,
        },
      });
  }
}

export function createPostgresDomainRepositories(
  db: CanonicalDb,
): PostgresDomainRepositoryBundle {
  return {
    apps: new PostgresAppRepository(db),
    agents: new PostgresAgentRepository(db),
    agentConfigs: new PostgresAgentConfigRepository(db),
    channelInstallations: new PostgresChannelInstallationRepository(db),
    conversations: new PostgresConversationRepository(db),
    messages: new PostgresMessageRepository(db),
    agentSessions: new PostgresAgentSessionRepository(db),
    providerSessions: new PostgresProviderSessionRepository(db),
    agentSessionSummaries: new PostgresAgentSessionSummaryRepository(db),
    agentRuns: new PostgresAgentRunRepository(db),
    runtimeEvents: new PostgresRuntimeEventRepository(db),
    memory: new PostgresMemoryRepository(db),
    jobs: new PostgresJobRepository(db),
    tools: new PostgresToolCatalogRepository(db),
    skills: new PostgresSkillCatalogRepository(db),
    mcpServers: new PostgresMcpServerRepository(db),
    permissions: new PostgresPermissionRepository(db),
    sandboxes: new PostgresSandboxRepository(db),
    browserProfiles: new PostgresBrowserProfileRepository(db),
  };
}
