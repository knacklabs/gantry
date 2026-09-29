import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

vi.mock('@core/config/memory.js', async () => {
  const actual = await vi.importActual<typeof import('@core/config/memory.js')>(
    '@core/config/memory.js',
  );
  return {
    ...actual,
    RUNTIME_MEMORY_ENABLED: true,
    RUNTIME_MEMORY_DREAMING_ENABLED: true,
    MEMORY_DREAMING_EMBED_PROVIDER: 'disabled',
    MEMORY_EMBED_PROVIDER: 'disabled',
  };
});

import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import { PostgresCanonicalGraphRepository } from '@core/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
  DEFAULT_PERMISSION_POLICY_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import type { ChannelWiring } from '@core/app/bootstrap/channel-wiring-types.js';
import { createChannelMessageActionRouter } from '@core/app/bootstrap/channel-message-action-router.js';
import { registerRuntimeMemoryReviewMessageAction } from '@core/app/bootstrap/runtime-memory-review-message-action.js';
import { ConversationAdministrationService } from '@core/application/provider-conversations/conversation-administration-service.js';
import { registerSlackMessageActionHandler } from '@core/channels/slack/channel-message-action-handler.js';
import type { ConversationId } from '@core/domain/conversation/conversation.js';
import type {
  ProviderAccountId,
  ProviderId,
} from '@core/domain/provider/provider.js';
import { createPendingMemoryReview } from '@core/memory/app-memory-review-create.js';
import { AppMemoryService } from '@core/memory/app-memory-service.js';
import { registerMemoryLlmClient } from '@core/memory/memory-llm-port.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

// The database and review path are real; only the Slack delivery edge is fake.
// The host runs this suite with GANTRY_TEST_DATABASE_URL.
const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe(
  'approving a learned memory through its Slack card (Postgres)',
  () => {
    let runtime: PostgresIntegrationRuntime;
    let service: AppMemoryService;
    let click: (reviewId: string) => Promise<{
      text: string;
      blocks: Array<{ type: string; text?: { text: string } }>;
    }>;
    const providerAccountId =
      'channel-providerAccount:learned-memory-review:slack' as ProviderAccountId;
    const conversationId =
      'conversation:learned-memory-review:slack' as ConversationId;
    const channelId = 'C_LEARNED_MEMORY_REVIEW';
    const reviewerId = 'U_LEARNED_MEMORY_REVIEWER';
    const subject = {
      appId: DEFAULT_APP_ID,
      agentId: DEFAULT_AGENT_ID,
      subjectType: 'group' as const,
      subjectId: 'main_agent',
      groupId: 'main_agent',
    };

    beforeAll(async () => {
      runtime = await createPostgresIntegrationRuntime({
        schemaPrefix: 'learned_memory_review',
      });
      _setRuntimeStorageForTest(runtime.storageRuntime);
      AppMemoryService.resetForTest();
      service = AppMemoryService.getInstance();
      registerMemoryLlmClient({
        isConfigured: () => false,
        query: async () => '[]',
      });

      const now = '2026-09-29T00:00:00.000Z';
      const repositories = runtime.repositories;
      await repositories.providerAccounts.saveProviderAccount({
        id: providerAccountId,
        appId: DEFAULT_APP_ID as never,
        agentId: DEFAULT_AGENT_ID as never,
        providerId: 'slack' as ProviderId,
        label: 'Learned memory review Slack',
        status: 'active',
        config: {},
        runtimeSecretRefs: {},
        createdAt: now,
        updatedAt: now,
      });
      await repositories.conversations.saveConversation({
        id: conversationId,
        appId: DEFAULT_APP_ID as never,
        providerAccountId,
        externalRef: { kind: 'conversation', value: channelId },
        kind: 'channel',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await repositories.providerAccounts.saveConversationInstall({
        id: 'agent-channel-binding:learned-memory-review' as never,
        appId: DEFAULT_APP_ID as never,
        agentId: DEFAULT_AGENT_ID as never,
        providerAccountId,
        conversationId,
        displayName: 'Learned memory review',
        status: 'active',
        senderPolicy: 'provider_native',
        controlPolicy: 'conversation_approvers',
        memoryScope: 'conversation',
        memorySubject: {
          kind: 'conversation',
          appId: DEFAULT_APP_ID as never,
          conversationId,
        },
        permissionPolicyIds: [DEFAULT_PERMISSION_POLICY_ID],
        createdAt: now,
        updatedAt: now,
      });

      await new PostgresCanonicalGraphRepository(
        runtime.service.db,
      ).ensureParticipant({
        conversationId,
        providerId: 'slack',
        providerAccountId,
        externalUserId: reviewerId,
      });
      const admin = new ConversationAdministrationService(repositories);
      await admin.replaceControlAllowlist({
        appId: DEFAULT_APP_ID as never,
        conversationId,
        userIds: [reviewerId],
        updatedAt: now,
      });

      const routes = {
        [`sl:${channelId}`]: {
          name: 'Learned memory review',
          folder: 'main_agent',
          trigger: '@agent',
          added_at: now,
          agentId: DEFAULT_AGENT_ID,
          providerAccountId,
        },
      };
      const messageActionRouter = createChannelMessageActionRouter();
      registerRuntimeMemoryReviewMessageAction(
        {
          getRuntimeAppId: () => DEFAULT_APP_ID,
          isControlApproverAllowed: (input) =>
            admin.isControlApproverAllowed({
              appId: DEFAULT_APP_ID as never,
              providerId: 'slack' as ProviderId,
              providerAccountId: input.providerAccountId as ProviderAccountId,
              agentId: DEFAULT_AGENT_ID as never,
              conversationJid: input.conversationJid,
              threadId: input.threadId,
              userId: input.userId,
            }),
          setMemoryReviewMessageActionHandler:
            messageActionRouter.setMemoryReviewHandler,
        } as ChannelWiring,
        { getConversationRoutes: () => routes },
      );

      let slackAction: ((args: unknown) => Promise<void>) | undefined;
      const updates: Array<{
        text: string;
        blocks: Array<{ type: string; text?: { text: string } }>;
      }> = [];
      registerSlackMessageActionHandler(
        {
          action: (
            _name: string | RegExp,
            handler: (args: unknown) => Promise<void>,
          ) => {
            slackAction = handler;
          },
          client: {
            chat: {
              update: async (message: (typeof updates)[number]) => {
                updates.push(message);
              },
              postEphemeral: async () => undefined,
            },
          },
        },
        {
          providerAccountId,
          onMessageAction: messageActionRouter.handle,
        },
      );
      click = async (reviewId) => {
        updates.length = 0;
        await slackAction!({
          ack: async () => undefined,
          action: {
            value: JSON.stringify({
              kind: 'memory_review_decision',
              reviewId,
              decision: 'approve',
            }),
          },
          body: {
            channel: { id: channelId },
            user: { id: reviewerId },
            message: { ts: '1710000000.100201' },
          },
        });
        expect(updates).toHaveLength(1);
        return updates[0]!;
      };
    }, 60_000);

    afterAll(async () => {
      AppMemoryService.resetForTest();
      await runtime.cleanup();
    });

    it('approves a candidate-backed review, saves the preference, and replaces the card with approval', async () => {
      const key = 'preference:meeting-notes';
      const value = 'Keep meeting notes in a short bulleted list.';
      await service.recordEvidence({
        ...subject,
        sourceType: 'session',
        sourceId: 'meeting-notes-session',
        actorId: { kind: 'system', source: 'integration-test' },
        text: value,
        metadata: {
          memoryCandidate: {
            kind: 'preference',
            scope: 'group',
            key,
            value,
            why: 'The group asked for short meeting notes.',
            confidence: 0.92,
            safety: 'safe',
          },
        },
      });
      const run = await service.triggerDreaming({
        ...subject,
        phase: 'all',
        dryRun: false,
      });
      expect(run.status).toBe('completed');
      const review = (await service.listPendingReviews(subject)).find(
        (item) => item.proposal.key === key,
      );
      expect(review?.proposal.candidateId).toBeTruthy();

      const approval = await click(review!.id);
      expect(approval.text).toBe('Memory review approved.');
      expect(approval.blocks).toEqual([
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'Memory review approved.' },
        },
      ]);
      const items = await runtime.service.db
        .select()
        .from(pgSchema.memoryItemsPostgres)
        .where(
          and(
            eq(pgSchema.memoryItemsPostgres.agentId, subject.agentId),
            eq(pgSchema.memoryItemsPostgres.key, key),
          ),
        );
      expect(items).toHaveLength(1);
      expect(items[0]?.status).toBe('active');
      expect(items[0]?.valueJson).toMatchObject({ value });
    });

    it('replaces a failed review card with the live item version failure', async () => {
      const key = 'decision:meeting-cadence';
      const replacement = 'The meeting now happens on Thursdays.';
      const item = await service.save({
        ...subject,
        kind: 'decision',
        key,
        value: 'The meeting happens on Tuesdays.',
        source: 'integration-test',
        confidence: 1,
        evidenceText: 'The meeting happens on Tuesdays.',
      });
      const evidence = await service.recordEvidence({
        ...subject,
        sourceType: 'session',
        sourceId: 'meeting-cadence-session',
        text: replacement,
      });
      const created = await createPendingMemoryReview({
        db: runtime.service.db,
        runId: 'meeting-cadence-review',
        subject,
        phase: 'deep',
        proposal: {
          action: 'needs_review',
          itemId: item.id,
          key,
          value: replacement,
          reason: 'The meeting cadence changed.',
          confidence: 0.9,
          evidenceIds: [evidence.id],
        },
      });
      expect(created.status).toBe('created');
      await service.patch({
        ...subject,
        id: item.id,
        expectedVersion: 1,
        value: 'The meeting now happens on Wednesdays.',
      });

      const failure = await click(created.reviewId);
      expect(failure.text).toBe(
        'Memory review failed: proposal target memory item version is stale',
      );
      expect(failure.blocks[0]?.text?.text).toBe(failure.text);
    });

    it('replaces an already-decided review card with an already-decided receipt', async () => {
      const key = 'decision:weekly-summary';
      const item = await service.save({
        ...subject,
        kind: 'decision',
        key,
        value: 'Use long weekly summaries.',
        source: 'integration-test',
        confidence: 1,
        evidenceText: 'Use long weekly summaries.',
      });
      const evidence = await service.recordEvidence({
        ...subject,
        sourceType: 'session',
        sourceId: 'already-decided-session',
        text: 'Use brief weekly summaries.',
      });
      const created = await createPendingMemoryReview({
        db: runtime.service.db,
        runId: 'already-decided-review',
        subject,
        phase: 'deep',
        proposal: {
          action: 'needs_review',
          itemId: item.id,
          key,
          value: 'Use brief weekly summaries.',
          reason: 'The group asked for brief summaries.',
          confidence: 0.9,
          evidenceIds: [evidence.id],
        },
      });
      expect(created.status).toBe('created');
      await service.decideReview({
        ...subject,
        reviewId: created.reviewId,
        decision: 'reject',
        reviewerId,
      });

      const alreadyDecided = await click(created.reviewId);
      expect(alreadyDecided.text).toBe('This review was already decided.');
      expect(alreadyDecided.blocks[0]?.text?.text).toBe(alreadyDecided.text);
    });
  },
);
