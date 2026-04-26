import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { Agent, AgentConfigVersion } from '../../../domain/agent/agent.js';
import type { App } from '../../../domain/app/app.js';
import type {
  AgentChannelBinding,
  ChannelInstallation,
} from '../../../domain/channel/channel.js';
import type {
  Conversation,
  ConversationThread,
} from '../../../domain/conversation/conversation.js';
import type { AgentRun, AgentRunEvent } from '../../../domain/events/events.js';
import type {
  Message,
  MessageAttachment,
  MessagePart,
} from '../../../domain/messages/messages.js';
import type {
  AgentSession,
  ProviderSession,
} from '../../../domain/sessions/sessions.js';
import * as pgSchema from './schema.js';

function encode(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function decode<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class PostgresCanonicalRepository {
  constructor(private readonly db: NodePgDatabase<typeof pgSchema>) {}

  async getApp(id: App['id']): Promise<App | null> {
    const row = (
      await this.db
        .select()
        .from(pgSchema.appsPostgres)
        .where(eq(pgSchema.appsPostgres.id, id))
        .limit(1)
    )[0];
    return row ? ({ ...row } as App) : null;
  }

  async saveApp(app: App): Promise<void> {
    await this.db.insert(pgSchema.appsPostgres).values(app).onConflictDoUpdate({
      target: pgSchema.appsPostgres.id,
      set: app,
    });
  }

  async getAgent(id: Agent['id']): Promise<Agent | null> {
    const row = (
      await this.db
        .select()
        .from(pgSchema.agentsPostgres)
        .where(eq(pgSchema.agentsPostgres.id, id))
        .limit(1)
    )[0];
    return row
      ? ({
          ...row,
          currentConfigVersionId: row.currentConfigVersionId ?? undefined,
        } as Agent)
      : null;
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
          appId: agent.appId,
          name: agent.name,
          status: agent.status,
          currentConfigVersionId: agent.currentConfigVersionId ?? null,
          updatedAt: agent.updatedAt,
        },
      });
  }

  async getConfigVersion(
    id: AgentConfigVersion['id'],
  ): Promise<AgentConfigVersion | null> {
    const row = (
      await this.db
        .select()
        .from(pgSchema.agentConfigVersionsPostgres)
        .where(eq(pgSchema.agentConfigVersionsPostgres.id, id))
        .limit(1)
    )[0];
    return row
      ? ({
          id: row.id,
          appId: row.appId,
          agentId: row.agentId,
          version: row.version,
          promptProfileRef: row.promptProfileRef,
          llmProfileId: row.llmProfileId,
          toolIds: decode(row.toolIdsJson, []),
          skillIds: decode(row.skillIdsJson, []),
          permissionPolicyIds: decode(row.permissionPolicyIdsJson, []),
          sandboxProfileId: row.sandboxProfileId ?? undefined,
          workspaceSnapshotId: row.workspaceSnapshotId ?? undefined,
          runtimeLimits: decode(row.runtimeLimitsJson, undefined),
          createdAt: row.createdAt,
        } as unknown as AgentConfigVersion)
      : null;
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
        toolIdsJson: encode(version.toolIds),
        skillIdsJson: encode(version.skillIds),
        permissionPolicyIdsJson: encode(version.permissionPolicyIds),
        sandboxProfileId: version.sandboxProfileId ?? null,
        workspaceSnapshotId: version.workspaceSnapshotId ?? null,
        runtimeLimitsJson: encode(version.runtimeLimits ?? {}),
        createdAt: version.createdAt,
      })
      .onConflictDoNothing();
  }

  async getChannelInstallation(
    id: ChannelInstallation['id'],
  ): Promise<ChannelInstallation | null> {
    const row = (
      await this.db
        .select()
        .from(pgSchema.channelInstallationsPostgres)
        .where(eq(pgSchema.channelInstallationsPostgres.id, id))
        .limit(1)
    )[0];
    return row
      ? ({
          id: row.id,
          appId: row.appId,
          providerId: row.providerId,
          externalInstallationRef: decode(row.externalRefJson, undefined),
          label: row.label,
          status: row.status,
          runtimeSecretRefs: decode(row.runtimeSecretRefsJson, []),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        } as unknown as ChannelInstallation)
      : null;
  }

  async saveChannelInstallation(
    installation: ChannelInstallation,
  ): Promise<void> {
    await this.db
      .insert(pgSchema.channelInstallationsPostgres)
      .values({
        id: installation.id,
        appId: installation.appId,
        providerId: installation.providerId,
        externalRefJson: encode(installation.externalInstallationRef),
        label: installation.label,
        status: installation.status,
        runtimeSecretRefsJson: encode(installation.runtimeSecretRefs),
        createdAt: installation.createdAt,
        updatedAt: installation.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.channelInstallationsPostgres.id,
        set: {
          externalRefJson: encode(installation.externalInstallationRef),
          label: installation.label,
          status: installation.status,
          runtimeSecretRefsJson: encode(installation.runtimeSecretRefs),
          updatedAt: installation.updatedAt,
        },
      });
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
        triggerPattern: binding.triggerPattern ?? null,
        requiresTrigger: binding.requiresTrigger,
        isAdminBinding: binding.isAdminBinding,
        memorySubjectJson: encode(binding.memorySubject),
        workspaceSnapshotId: binding.workspaceSnapshotId ?? null,
        permissionPolicyIdsJson: encode(binding.permissionPolicyIds),
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.agentChannelBindingsPostgres.id,
        set: {
          displayName: binding.displayName,
          triggerPattern: binding.triggerPattern ?? null,
          requiresTrigger: binding.requiresTrigger,
          isAdminBinding: binding.isAdminBinding,
          memorySubjectJson: encode(binding.memorySubject),
          workspaceSnapshotId: binding.workspaceSnapshotId ?? null,
          permissionPolicyIdsJson: encode(binding.permissionPolicyIds),
          updatedAt: binding.updatedAt,
        },
      });
  }

  async listAgentChannelBindings(
    appId: App['id'],
  ): Promise<AgentChannelBinding[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentChannelBindingsPostgres)
      .where(eq(pgSchema.agentChannelBindingsPostgres.appId, appId));
    return rows.map(
      (row) =>
        ({
          id: row.id,
          appId: row.appId,
          agentId: row.agentId,
          channelInstallationId: row.channelInstallationId,
          conversationId: row.conversationId,
          threadId: row.threadId ?? undefined,
          displayName: row.displayName,
          triggerPattern: row.triggerPattern ?? undefined,
          requiresTrigger: row.requiresTrigger,
          isAdminBinding: row.isAdminBinding,
          memorySubject: decode(row.memorySubjectJson, { kind: 'app', appId }),
          workspaceSnapshotId: row.workspaceSnapshotId ?? undefined,
          permissionPolicyIds: decode(row.permissionPolicyIdsJson, []),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }) as unknown as AgentChannelBinding,
    );
  }

  async getConversation(id: Conversation['id']): Promise<Conversation | null> {
    const row = (
      await this.db
        .select()
        .from(pgSchema.conversationsPostgres)
        .where(eq(pgSchema.conversationsPostgres.id, id))
        .limit(1)
    )[0];
    return row
      ? ({
          id: row.id,
          appId: row.appId,
          channelInstallationId: row.channelInstallationId,
          externalRef: decode(row.externalRefJson, undefined),
          kind: row.kind,
          title: row.title ?? undefined,
          status: row.status,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        } as Conversation)
      : null;
  }

  async getThread(
    id: ConversationThread['id'],
  ): Promise<ConversationThread | null> {
    const row = (
      await this.db
        .select()
        .from(pgSchema.conversationThreadsPostgres)
        .where(eq(pgSchema.conversationThreadsPostgres.id, id))
        .limit(1)
    )[0];
    return row
      ? ({
          id: row.id,
          appId: row.appId,
          conversationId: row.conversationId,
          externalRef: decode(row.externalRefJson, undefined),
          title: row.title ?? undefined,
          status: row.status,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        } as ConversationThread)
      : null;
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    await this.db
      .insert(pgSchema.conversationsPostgres)
      .values({
        id: conversation.id,
        appId: conversation.appId,
        channelInstallationId: conversation.channelInstallationId,
        externalRefJson: encode(conversation.externalRef),
        kind: conversation.kind,
        title: conversation.title ?? null,
        status: conversation.status,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.conversationsPostgres.id,
        set: {
          externalRefJson: encode(conversation.externalRef),
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
        externalRefJson: encode(thread.externalRef),
        title: thread.title ?? null,
        status: thread.status,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.conversationThreadsPostgres.id,
        set: {
          externalRefJson: encode(thread.externalRef),
          title: thread.title ?? null,
          status: thread.status,
          updatedAt: thread.updatedAt,
        },
      });
  }

  async getMessage(id: Message['id']): Promise<Message | null> {
    const rows = await this.listMessagesByIds([id]);
    return rows[0] ?? null;
  }

  async saveMessage(message: Message): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(pgSchema.canonicalMessagesPostgres)
        .values({
          id: message.id,
          appId: message.appId,
          conversationId: message.conversationId,
          threadId: message.threadId ?? null,
          externalRefJson: encode(message.externalRef),
          direction: message.direction,
          senderUserId: message.senderUserId ?? null,
          senderDisplayName: message.senderDisplayName ?? null,
          trust: message.trust,
          createdAt: message.createdAt,
          receivedAt: message.receivedAt ?? null,
        })
        .onConflictDoUpdate({
          target: pgSchema.canonicalMessagesPostgres.id,
          set: {
            externalRefJson: encode(message.externalRef),
            senderDisplayName: message.senderDisplayName ?? null,
            trust: message.trust,
            receivedAt: message.receivedAt ?? null,
          },
        });
      await tx
        .delete(pgSchema.messagePartsPostgres)
        .where(eq(pgSchema.messagePartsPostgres.messageId, message.id));
      await tx
        .delete(pgSchema.messageAttachmentsPostgres)
        .where(eq(pgSchema.messageAttachmentsPostgres.messageId, message.id));
      if (message.parts.length > 0) {
        await tx.insert(pgSchema.messagePartsPostgres).values(
          message.parts.map((part, index) => ({
            messageId: message.id,
            ordinal: index,
            kind: part.kind,
            payloadJson: encode(part),
          })),
        );
      }
      if (message.attachments.length > 0) {
        await tx.insert(pgSchema.messageAttachmentsPostgres).values(
          message.attachments.map((attachment) => ({
            id: attachment.id,
            messageId: message.id,
            kind: attachment.kind,
            contentType: attachment.contentType ?? null,
            sizeBytes: attachment.sizeBytes ?? null,
            externalRefJson: encode(attachment.externalRef),
            storageRef: attachment.storageRef ?? null,
            trust: attachment.trust,
          })),
        );
      }
    });
  }

  async listMessages(input: {
    conversationId: Message['conversationId'];
    threadId?: Message['threadId'];
    limit?: number;
  }): Promise<Message[]> {
    const rows = await this.db
      .select({ id: pgSchema.canonicalMessagesPostgres.id })
      .from(pgSchema.canonicalMessagesPostgres)
      .where(
        input.threadId
          ? and(
              eq(
                pgSchema.canonicalMessagesPostgres.conversationId,
                input.conversationId,
              ),
              eq(pgSchema.canonicalMessagesPostgres.threadId, input.threadId),
            )
          : eq(
              pgSchema.canonicalMessagesPostgres.conversationId,
              input.conversationId,
            ),
      )
      .orderBy(
        asc(pgSchema.canonicalMessagesPostgres.createdAt),
        asc(pgSchema.canonicalMessagesPostgres.id),
      )
      .limit(input.limit ?? 100);
    return this.listMessagesByIds(rows.map((row) => row.id));
  }

  private async listMessagesByIds(ids: string[]): Promise<Message[]> {
    if (ids.length === 0) return [];
    const result: Message[] = [];
    for (const id of ids) {
      const row = (
        await this.db
          .select()
          .from(pgSchema.canonicalMessagesPostgres)
          .where(eq(pgSchema.canonicalMessagesPostgres.id, id))
          .limit(1)
      )[0];
      if (!row) continue;
      const partRows = await this.db
        .select()
        .from(pgSchema.messagePartsPostgres)
        .where(eq(pgSchema.messagePartsPostgres.messageId, id))
        .orderBy(asc(pgSchema.messagePartsPostgres.ordinal));
      const attachmentRows = await this.db
        .select()
        .from(pgSchema.messageAttachmentsPostgres)
        .where(eq(pgSchema.messageAttachmentsPostgres.messageId, id));
      result.push({
        id: row.id,
        appId: row.appId,
        conversationId: row.conversationId,
        threadId: row.threadId ?? undefined,
        externalRef: decode(row.externalRefJson, undefined),
        direction: row.direction,
        senderUserId: row.senderUserId ?? undefined,
        senderDisplayName: row.senderDisplayName ?? undefined,
        trust: row.trust,
        createdAt: row.createdAt,
        receivedAt: row.receivedAt ?? undefined,
        parts: partRows.map((part) =>
          decode<MessagePart>(part.payloadJson, {
            kind: 'redacted',
            reason: 'invalid_message_part',
          }),
        ),
        attachments: attachmentRows.map(
          (attachment) =>
            ({
              id: attachment.id,
              messageId: attachment.messageId,
              kind: attachment.kind,
              contentType: attachment.contentType ?? undefined,
              sizeBytes: attachment.sizeBytes ?? undefined,
              externalRef: decode(attachment.externalRefJson, undefined),
              storageRef: attachment.storageRef ?? undefined,
              trust: attachment.trust,
            }) as MessageAttachment,
        ),
      } as Message);
    }
    return result;
  }

  async getAgentSession(id: AgentSession['id']): Promise<AgentSession | null> {
    const row = (
      await this.db
        .select()
        .from(pgSchema.agentSessionsPostgres)
        .where(eq(pgSchema.agentSessionsPostgres.id, id))
        .limit(1)
    )[0];
    return row ? ({ ...row } as AgentSession) : null;
  }

  async saveAgentSession(session: AgentSession): Promise<void> {
    await this.db
      .insert(pgSchema.agentSessionsPostgres)
      .values({
        id: session.id,
        appId: session.appId,
        agentId: session.agentId,
        conversationId: session.conversationId ?? null,
        threadId: session.threadId ?? null,
        jobId: session.jobId ?? null,
        userId: session.userId ?? null,
        status: session.status,
        modelOverride: session.modelOverride ?? null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        resetAt: session.resetAt ?? null,
      })
      .onConflictDoUpdate({
        target: pgSchema.agentSessionsPostgres.id,
        set: {
          status: session.status,
          modelOverride: session.modelOverride ?? null,
          updatedAt: session.updatedAt,
          resetAt: session.resetAt ?? null,
        },
      });
  }

  async getProviderSession(
    id: ProviderSession['id'],
  ): Promise<ProviderSession | null> {
    const row = (
      await this.db
        .select()
        .from(pgSchema.providerSessionsPostgres)
        .where(eq(pgSchema.providerSessionsPostgres.id, id))
        .limit(1)
    )[0];
    return row
      ? ({
          id: row.id,
          appId: row.appId,
          agentSessionId: row.agentSessionId,
          providerRef: decode(row.providerRefJson, {
            kind: 'provider_session',
            value: row.id,
          }),
          status: row.status,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        } as ProviderSession)
      : null;
  }

  async saveProviderSession(session: ProviderSession): Promise<void> {
    await this.db
      .insert(pgSchema.providerSessionsPostgres)
      .values({
        id: session.id,
        appId: session.appId,
        agentSessionId: session.agentSessionId,
        providerRefJson: encode(session.providerRef),
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })
      .onConflictDoUpdate({
        target: pgSchema.providerSessionsPostgres.id,
        set: {
          providerRefJson: encode(session.providerRef),
          status: session.status,
          updatedAt: session.updatedAt,
        },
      });
  }

  async getAgentRun(id: AgentRun['id']): Promise<AgentRun | null> {
    const row = (
      await this.db
        .select()
        .from(pgSchema.agentRunsPostgres)
        .where(eq(pgSchema.agentRunsPostgres.id, id))
        .limit(1)
    )[0];
    return row
      ? ({
          id: row.id,
          appId: row.appId,
          agentId: row.agentId,
          configVersionId: row.configVersionId,
          sessionId: row.sessionId ?? undefined,
          conversationId: row.conversationId ?? undefined,
          threadId: row.threadId ?? undefined,
          messageId: row.messageId ?? undefined,
          jobId: row.jobId ?? undefined,
          llmProfileId: row.llmProfileId,
          permissionDecisionIds: decode(row.permissionDecisionIdsJson, []),
          sandboxLeaseId: row.sandboxLeaseId ?? undefined,
          workspaceSnapshotId: row.workspaceSnapshotId ?? undefined,
          cause: row.cause,
          status: row.status,
          createdAt: row.createdAt,
          startedAt: row.startedAt ?? undefined,
          endedAt: row.endedAt ?? undefined,
          resultSummary: row.resultSummary ?? undefined,
          errorSummary: row.errorSummary ?? undefined,
        } as unknown as AgentRun)
      : null;
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
        permissionDecisionIdsJson: encode(run.permissionDecisionIds),
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
          status: run.status,
          endedAt: run.endedAt ?? null,
          resultSummary: run.resultSummary ?? null,
          errorSummary: run.errorSummary ?? null,
        },
      });
  }

  async appendAgentRunEvent(event: AgentRunEvent): Promise<void> {
    await this.db.insert(pgSchema.agentRunEventsPostgres).values({
      id: event.id,
      appId: event.appId,
      runId: event.runId,
      type: event.type,
      payloadJson: encode(event.payload),
      createdAt: event.createdAt,
    });
  }

  async listAgentRunEvents(runId: AgentRun['id']): Promise<AgentRunEvent[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.agentRunEventsPostgres)
      .where(eq(pgSchema.agentRunEventsPostgres.runId, runId))
      .orderBy(asc(pgSchema.agentRunEventsPostgres.createdAt));
    return rows.map(
      (row) =>
        ({
          id: row.id,
          appId: row.appId,
          runId: row.runId,
          type: row.type,
          payload: decode(row.payloadJson, null),
          createdAt: row.createdAt,
        }) as AgentRunEvent,
    );
  }
}
