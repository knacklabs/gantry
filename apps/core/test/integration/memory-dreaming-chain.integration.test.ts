import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { and, eq } from 'drizzle-orm';

// Memory dreaming is gated behind RUNTIME_MEMORY_DREAMING_ENABLED, which is a
// module-level constant read once from runtime memory settings (default false).
// Enable it for this suite while keeping every other config export real, and
// keep dreaming/recall embeddings disabled so promotion and `memory_search`
// stay deterministic and lexical (no live embedding provider).
vi.mock('@core/config/memory.js', async () => {
  const actual = await vi.importActual<typeof import('@core/config/memory.js')>(
    '@core/config/memory.js',
  );
  return {
    ...actual,
    RUNTIME_MEMORY_ENABLED: true,
    RUNTIME_MEMORY_DREAMING_ENABLED: true,
    MEMORY_DREAMING_EMBEDDINGS_ENABLED: false,
    MEMORY_DREAMING_EMBED_PROVIDER: 'disabled',
    MEMORY_EMBED_PROVIDER: 'disabled',
  };
});

import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import { AppMemoryService } from '@core/memory/app-memory-service.js';
import {
  processMemoryRequest,
  resolveTrustedMemorySubject,
} from '@core/memory/memory-ipc.js';
import {
  registerMemoryLlmClient,
  type MemoryLlmClient,
  type MemoryLlmQueryOpts,
} from '@core/memory/memory-llm-port.js';
import { loadSessionAppMemoryItems } from '@core/memory/app-memory-session-hydration.js';
import { HydrateAgentContextService } from '@core/application/sessions/hydrate-agent-context-service.js';
import type { NormalizedMemorySubject } from '@core/memory/memory-types.js';
import type { MemoryIpcResponse } from '@gantry/contracts';
import type {
  AgentSession,
  AgentSessionId,
} from '@core/domain/sessions/sessions.js';
import type { AgentSessionRepository } from '@core/domain/ports/repositories.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

// Two source agents, each pinned to one scope so the resolved memory subjects
// are disjoint: the channel agent always resolves to a `channel` subject (keyed
// by conversation id) and the DM agent always resolves to a `user` subject
// (keyed by user id).
const CHANNEL_AGENT_FOLDER = 'channel_scope_agent';
const CHANNEL_CHAT_JID = 'tg:channel-9001';
const DM_AGENT_FOLDER = 'dm_scope_agent';
const DM_USER_ID = 'tg:user-77';
const DM_CHAT_JID = 'tg:dm-77';

const CHANNEL_CONTEXT = {
  chatJid: CHANNEL_CHAT_JID,
  defaultScope: 'group' as const,
};
const DM_CONTEXT = {
  chatJid: DM_CHAT_JID,
  userId: DM_USER_ID,
  defaultScope: 'user' as const,
};

interface ScopeFixture {
  label: 'channel' | 'dm';
  sourceAgentFolder: string;
  context: { chatJid: string; userId?: string; defaultScope: 'group' | 'user' };
  subjectType: 'channel' | 'user';
  // A distinctive token that exists ONLY in this scope's promoted memory, used
  // to prove `memory_search` cross-scope isolation.
  promoteKey: string;
  promoteValue: string;
  searchToken: string;
}

const SCOPES: ScopeFixture[] = [
  {
    label: 'channel',
    sourceAgentFolder: CHANNEL_AGENT_FOLDER,
    context: CHANNEL_CONTEXT,
    subjectType: 'channel',
    promoteKey: 'decision:deploy-window',
    promoteValue: 'Channel deploys land on Tuesday afternoon windows.',
    searchToken: 'Tuesday',
  },
  {
    label: 'dm',
    sourceAgentFolder: DM_AGENT_FOLDER,
    context: DM_CONTEXT,
    subjectType: 'user',
    promoteKey: 'decision:editor-indent',
    promoteValue: 'Private notes prefer four-space indentation everywhere.',
    searchToken: 'indentation',
  },
];

function subjectForScope(scope: ScopeFixture): NormalizedMemorySubject {
  return resolveTrustedMemorySubject(scope.sourceAgentFolder, scope.context);
}

/**
 * Seed evidence the way a real run does (memory_save's evidence-ingestion seam
 * goes through AppMemoryService.recordEvidence). The structured-candidate
 * metadata is exactly the durable extraction shape the boundary extractor
 * stages; here it is deterministic instead of LLM-produced.
 */
async function seedStructuredEvidence(
  service: AppMemoryService,
  scope: ScopeFixture,
): Promise<string> {
  const subject = subjectForScope(scope);
  const evidence = await service.recordEvidence({
    appId: subject.appId,
    agentId: subject.agentId,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    ...(subject.userId ? { userId: subject.userId } : {}),
    ...(subject.groupId ? { groupId: subject.groupId } : {}),
    ...(subject.channelId ? { channelId: subject.channelId } : {}),
    sourceType: 'session',
    sourceId: `run:${scope.label}`,
    actorId: 'integration-test',
    text: scope.promoteValue,
    metadata: {
      memoryCandidate: {
        kind: 'decision',
        scope: scope.subjectType === 'user' ? 'user' : 'group',
        key: scope.promoteKey,
        value: scope.promoteValue,
        why: `Durable decision grounded in the ${scope.label} run transcript.`,
        confidence: 0.92,
        safety: 'safe',
      },
    },
  });
  return evidence.id;
}

function activeItemRows(
  runtime: PostgresIntegrationRuntime,
  subject: NormalizedMemorySubject,
) {
  return runtime.service.db
    .select()
    .from(pgSchema.memoryItemsPostgres)
    .where(
      and(
        eq(pgSchema.memoryItemsPostgres.appId, subject.appId),
        eq(pgSchema.memoryItemsPostgres.agentId, subject.agentId),
        eq(pgSchema.memoryItemsPostgres.subjectType, subject.subjectType),
        eq(pgSchema.memoryItemsPostgres.status, 'active'),
      ),
    );
}

function memorySearch(
  scope: ScopeFixture,
  query: string,
): Promise<MemoryIpcResponse> {
  return processMemoryRequest(
    {
      requestId: `req-${scope.label}-${Math.random().toString(36).slice(2)}`,
      action: 'memory_search',
      payload: { query, limit: 10 },
      context: scope.context,
    } as never,
    scope.sourceAgentFolder,
  );
}

function searchResultKeys(response: MemoryIpcResponse): string[] {
  const data = response.data as
    { results?: Array<{ item?: { key?: string } }> } | undefined;
  return (data?.results ?? [])
    .map((result) => result.item?.key)
    .filter((key): key is string => Boolean(key));
}

function sessionForScope(scope: ScopeFixture): AgentSession {
  const now = '2026-06-12T00:00:00.000Z';
  const subject = subjectForScope(scope);
  return {
    id: `agent-session:${scope.label}` as AgentSessionId,
    appId: subject.appId as never,
    agentId: subject.agentId as never,
    conversationId: `conversation:${scope.context.chatJid}` as never,
    ...(scope.subjectType === 'user'
      ? { userId: scope.context.userId as never }
      : {}),
    status: 'active',
    createdAt: now as never,
    updatedAt: now as never,
  };
}

function hydrationServiceForScope(scope: ScopeFixture) {
  const session = sessionForScope(scope);
  const sessions: Partial<AgentSessionRepository> = {
    getAgentSession: async (id: AgentSessionId) =>
      id === session.id ? session : null,
  };
  return new HydrateAgentContextService(
    sessions as AgentSessionRepository,
    {},
    { loadAppMemoryItems: loadSessionAppMemoryItems },
  );
}

maybeDescribe(
  'memory evidence -> dreaming -> memory_search -> hydration chain',
  () => {
    let runtime: PostgresIntegrationRuntime;
    let service: AppMemoryService;
    const restoreLlm: Array<() => void> = [];

    beforeAll(async () => {
      runtime = await createPostgresIntegrationRuntime({
        schemaPrefix: 'memory_dreaming_chain',
      });
      _setRuntimeStorageForTest(runtime.storageRuntime);
      AppMemoryService.resetForTest();
      service = new AppMemoryService(runtime.service.db);
      // Default LLM client is "unconfigured" so dreaming proposals are skipped;
      // individual tests register a deterministic fake when they exercise review.
      registerMemoryLlmClient({
        isConfigured: () => false,
        query: async () => '[]',
      });
    }, 60_000);

    afterAll(async () => {
      AppMemoryService.resetForTest();
      await runtime.cleanup();
    });

    afterEach(() => {
      while (restoreLlm.length) restoreLlm.pop()!();
      registerMemoryLlmClient({
        isConfigured: () => false,
        query: async () => '[]',
      });
    });

    for (const scope of SCOPES) {
      describe(`${scope.label} scope`, () => {
        it('promotes structured evidence into durable memory via dreaming', async () => {
          const subject = subjectForScope(scope);
          expect(subject.subjectType).toBe(scope.subjectType);

          const evidenceId = await seedStructuredEvidence(service, scope);
          expect(evidenceId).toMatch(/^mev_/);

          const beforePromotion = await activeItemRows(runtime, subject);
          expect(
            beforePromotion.some((row) => row.key === scope.promoteKey),
          ).toBe(false);

          // Stage 2: trigger dreaming. phase 'all' stages the structured
          // candidate (light) then validates + promotes it (deep). The IPC
          // memory_dream/memory_consolidate path spreads the full resolved
          // subject (including userId/channelId), so do the same here so the
          // promoted item carries its scope columns.
          const run = await service.triggerDreaming({
            ...subject,
            phase: 'all',
            dryRun: false,
          });
          expect(run.status).toBe('completed');

          const afterPromotion = await activeItemRows(runtime, subject);
          const promoted = afterPromotion.find(
            (row) => row.key === scope.promoteKey,
          );
          expect(promoted, 'promoted memory item must exist').toBeTruthy();
          const source = promoted!.sourceRefJson as Record<string, unknown>;
          expect(source.source).toBe('dreaming');
          expect(source.promoted_by).toBe('dreaming');
          expect(source.dream_run_id).toBe(run.runId);
          expect(source.dream_candidate_id).toEqual(expect.any(String));

          // A dreaming run + applied decision are recorded durably.
          const decisions = await runtime.service.db
            .select()
            .from(pgSchema.memoryDreamDecisionsPostgres)
            .where(eq(pgSchema.memoryDreamDecisionsPostgres.runId, run.runId));
          expect(
            decisions.some((d) => d.action === 'promote' && d.applied === true),
          ).toBe(true);
        });

        it('finds the promoted memory through the real memory IPC path and enforces scope isolation', async () => {
          const response = await memorySearch(scope, scope.searchToken);
          expect(response.ok).toBe(true);
          const keys = searchResultKeys(response);
          expect(keys).toContain(scope.promoteKey);

          // Scope isolation: the OTHER scope's distinctive token must NOT surface
          // this scope's memory, and the other scope's promoted key must be
          // invisible from here.
          const otherScope = SCOPES.find((s) => s.label !== scope.label)!;
          const crossResponse = await memorySearch(
            scope,
            otherScope.searchToken,
          );
          expect(crossResponse.ok).toBe(true);
          expect(searchResultKeys(crossResponse)).not.toContain(
            otherScope.promoteKey,
          );
          // And searching this scope's token never leaks the other scope's key.
          expect(keys).not.toContain(otherScope.promoteKey);
        });

        it('hydrates the promoted memory into the fresh-run context block under the correct scope', async () => {
          const hydration = hydrationServiceForScope(scope);
          const result = await hydration.hydrate({
            sessionId: `agent-session:${scope.label}` as AgentSessionId,
            conversationKind: scope.subjectType === 'user' ? 'dm' : 'channel',
          });

          expect(result.block).toContain(
            '<gantry_memory_context trust="untrusted_data_only">',
          );
          expect(result.block).toContain('</gantry_memory_context>');
          expect(result.block).toContain(scope.promoteKey);
          expect(result.memories.map((m) => m.key)).toContain(scope.promoteKey);

          // Fresh-run hydration under the OTHER scope must not surface this
          // scope's memory.
          const otherScope = SCOPES.find((s) => s.label !== scope.label)!;
          const otherHydration = hydrationServiceForScope(otherScope);
          const otherResult = await otherHydration.hydrate({
            sessionId: `agent-session:${otherScope.label}` as AgentSessionId,
            conversationKind:
              otherScope.subjectType === 'user' ? 'dm' : 'channel',
          });
          expect(otherResult.block).not.toContain(scope.promoteKey);
        });
      });
    }

    it('routes a faked-LLM lifecycle proposal to durable review and applies it on approve', async () => {
      // Use the channel scope, on a fresh active item, to exercise the review
      // branch deterministically. The fake MemoryLlmClient returns a needs_review
      // rewrite proposal whose value is grounded in the evidence corpus.
      const scope = SCOPES[0]!;
      const subject = subjectForScope(scope);

      const reviewKey = 'decision:retro-cadence';
      const groundedValue = 'Retrospectives now run every second Thursday.';
      // Seed an active item + grounding evidence for the rewrite target.
      const seeded = await service.save({
        appId: subject.appId,
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        ...(subject.channelId ? { channelId: subject.channelId } : {}),
        ...(subject.groupId ? { groupId: subject.groupId } : {}),
        kind: 'decision',
        key: reviewKey,
        value: 'Retrospectives run weekly.',
        why: 'Initial cadence.',
        source: 'integration-test',
        confidence: 1,
        evidenceText:
          'The team decided Retrospectives now run every second Thursday cadence.',
      });
      const evidenceRow = await runtime.service.db
        .select()
        .from(pgSchema.memoryEvidencePostgres)
        .where(
          and(
            eq(pgSchema.memoryEvidencePostgres.appId, subject.appId),
            eq(pgSchema.memoryEvidencePostgres.agentId, subject.agentId),
            eq(
              pgSchema.memoryEvidencePostgres.subjectType,
              subject.subjectType,
            ),
          ),
        );
      const groundingEvidenceId = evidenceRow.find((row) =>
        row.text.includes('every second Thursday'),
      )?.id;
      expect(groundingEvidenceId).toBeTruthy();

      const fakeLlm: MemoryLlmClient = {
        isConfigured: () => true,
        query: async (opts: MemoryLlmQueryOpts) => {
          // Only the dreaming-proposal prompt should drive a needs_review item;
          // consolidation returns nothing.
          if (opts.systemPrompt?.includes('consolidate active memory')) {
            return '[]';
          }
          return JSON.stringify([
            {
              action: 'needs_review',
              item_id: seeded.id,
              value: groundedValue,
              reason: 'Cadence changed; rewrite requires review.',
              confidence: 0.9,
              evidence_ids: [groundingEvidenceId],
            },
          ]);
        },
      };
      registerMemoryLlmClient(fakeLlm);

      const run = await service.triggerDreaming({
        appId: subject.appId,
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        phase: 'deep',
        dryRun: false,
      });
      expect(run.status).toBe('completed');

      const pending = await service.listPendingReviews({
        appId: subject.appId,
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
      });
      const review = pending.find((r) => r.proposal.itemId === seeded.id);
      expect(
        review,
        'dreaming must create a durable pending review',
      ).toBeTruthy();
      expect(review!.status).toBe('pending_review');
      expect(review!.proposal.action).toBe('needs_review');

      // Approve the review; the rewrite is applied to the durable item.
      const decided = await service.decideReview({
        appId: subject.appId,
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        reviewId: review!.id,
        decision: 'approve',
        reviewerId: 'integration-reviewer',
      });
      expect(decided.status).toBe('applied');

      const afterRows = await runtime.service.db
        .select()
        .from(pgSchema.memoryItemsPostgres)
        .where(eq(pgSchema.memoryItemsPostgres.id, seeded.id));
      const rewritten = afterRows[0]!.valueJson as { value?: string };
      expect(rewritten.value).toBe(groundedValue);
    });
  },
);
