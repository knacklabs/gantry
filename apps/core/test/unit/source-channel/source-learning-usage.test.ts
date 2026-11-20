import { afterEach, expect, it, vi } from 'vitest';
import { saveSourceLearning } from '../../../src/memory/source-learning-service.js';
import {
  configureCustomModelCatalogEntries,
  resolveModelSelectionForWorkload,
} from '../../../src/shared/model-catalog.js';
import { createSourceModelSnapshot } from '../../../src/shared/source-model-snapshot.js';
afterEach(() => {
  configureCustomModelCatalogEntries([]);
});
it.each([
  ['same-raw-aliases', 'gpt-5.5'],
  ['settings-switch', 'gpt-5.5'],
  ['same-raw-aliases', 'haiku'],
  ['settings-switch', 'haiku'],
  ['alias-removal', 'gpt-5.5'],
  ['alias-removal', 'haiku'],
])('keeps learning usage pinned for %s with %s', async (scenario, before) => {
  const selected = resolveModelSelectionForWorkload(before, 'chat');
  const changed = resolveModelSelectionForWorkload(
    before === 'haiku' ? 'gpt-5.5' : 'haiku',
    'chat',
  );
  if (!selected.ok || !changed.ok) throw new Error('Model fixture absent');
  const entry = {
    ...selected.entry,
    id: 'usage-pin-chat',
    aliases: ['manipal.chat'],
    recommendedAlias: 'manipal.chat',
    runnerModel: before === 'haiku' ? selected.entry.runnerModel : 'gpt-6-luna',
    inputUsdPerMillionTokens: 10,
    outputUsdPerMillionTokens: 20,
    cachedInputUsdPerMillionTokens: 2,
  };
  const pin = createSourceModelSnapshot('manipal.chat', entry);
  configureCustomModelCatalogEntries([
    entry,
    {
      ...entry,
      id: 'usage-pin-research',
      aliases: ['manipal.research'],
      recommendedAlias: 'manipal.research',
      inputUsdPerMillionTokens: 999,
    },
  ]);
  const scope = {
    appId: 'app',
    agentId: 'agent',
    chatJid: 'app:app:D1',
    personId: 'person',
    workspaceId: 'W1',
    runId: 'run',
  };
  const subject = { subjectType: 'group', subjectId: 'W1' };
  const context = {
    answerId: 'answer',
    sessionId: 'session',
    claimToken: 'claim',
    request: {
      model: 'manipal.chat',
      questionSourceId: 'M1',
      answerGoalId: 'goal',
    },
    modelSnapshot: pin,
    scope,
    subject,
    deadlineAtMs: Date.now() + 10000,
  };
  const evidence = [
    {
      sourceMessageId: 'M1',
      authorId: 'person',
      text: 'Please keep answers simple.',
      createdAt: '2026-11-20',
      revisionId: 'R1',
    },
  ];
  const publish = vi.fn(async () => {});
  const audit = vi.fn(async () => {});
  const repository = {
    context: async () => context,
    acquire: async () => true,
    stage: async () => ({
      id: 'candidate',
      context,
      evidence,
      replayed: false,
    }),
    read: async () => ({ status: 'staged', evidenceIdsJson: '["E1"]' }),
    authorize: async () => 'authority',
    decision: async () => {},
    audit,
    release: async () => {},
  };
  await saveSourceLearning({
    scope,
    subject: subject as never,
    proposal: {
      kind: 'preference',
      key: 'style',
      value: 'Keep answers simple',
      source: 'discussion-explicit',
      supportingSourceIds: ['M1'],
    },
    repository: repository as never,
    memory: { save: async () => ({ id: 'memory' }) } as never,
    publish,
    client: {
      isConfigured: () => true,
      query: async (opts) => {
        expect(opts.model).toBe(entry.runnerModel);
        opts.onUsage?.({
          input_tokens: 70,
          output_tokens: 10,
          cache_read_input_tokens: 30,
        });
        if (scenario === 'alias-removal')
          configureCustomModelCatalogEntries([]);
        if (scenario === 'settings-switch')
          configureCustomModelCatalogEntries([
            {
              ...changed.entry,
              id: 'usage-pin-changed',
              aliases: ['manipal.chat'],
              recommendedAlias: 'manipal.chat',
            },
          ]);
        return JSON.stringify({
          decision: 'allow',
          reusable: true,
          tenderFact: false,
          sensitiveProfile: false,
          scopeAppropriate: true,
          grounding: 'explicit_instruction',
          confidence: 0.99,
          supportingSourceIds: ['M1'],
          reason: 'Human style instruction',
        });
      },
    },
  });
  expect(publish).toHaveBeenCalledOnce();
  const event = publish.mock.calls[0][0] as any;
  expect(event.payload).toMatchObject({
    modelAlias: 'manipal.chat',
    providerId: entry.modelRoute.id,
    stage: 'source_learning_validation',
    usage: {
      model: 'manipal.chat',
      provider: entry.modelRoute.id,
      responseFamily: entry.responseFamily,
      modelRoute: entry.modelRoute.id,
      inputTokens: before === 'haiku' ? 70 : 100,
      outputTokens: 10,
      cacheReadTokens: 30,
      totalBillableInputTokens: 70,
    },
  });
  expect(event.payload.usage.estimatedCostUsd).toBeCloseTo(0.00096);
  expect(audit.mock.calls[0][1].validatorUsage).toEqual(event.payload.usage);
});
