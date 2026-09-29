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

import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import { AppMemoryService } from '@core/memory/app-memory-service.js';
import { registerMemoryLlmClient } from '@core/memory/memory-llm-port.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('approving a learned memory (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let service: AppMemoryService;

  const subject = {
    appId: 'default',
    agentId: 'agent:learned-memory-review',
    subjectType: 'group' as const,
    subjectId: 'learned-memory-review',
    groupId: 'learned-memory-review',
  };
  const key = 'preference:meeting-notes';
  const value = 'Keep meeting notes in a short bulleted list.';

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'learned_memory_review',
    });
    AppMemoryService.resetForTest();
    service = new AppMemoryService(runtime.service.db);
    registerMemoryLlmClient({
      isConfigured: () => false,
      query: async () => '[]',
    });
  }, 60_000);

  afterAll(async () => {
    AppMemoryService.resetForTest();
    await runtime.cleanup();
  });

  it('approves a candidate-backed review and saves the learned preference', async () => {
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

    const pending = await service.listPendingReviews(subject);
    const review = pending.find((item) => item.proposal.key === key);
    expect(review?.proposal.candidateId).toBeTruthy();
    expect(review?.status).toBe('pending_review');

    const decided = await service.decideReview({
      ...subject,
      reviewId: review!.id,
      decision: 'approve',
      reviewerId: 'integration-reviewer',
    });
    expect(['approved', 'applied']).toContain(decided.status);

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
});
