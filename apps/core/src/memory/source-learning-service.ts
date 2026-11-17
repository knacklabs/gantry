import { randomUUID } from 'node:crypto';
import type {
  SourceLearningScope,
  SourceLearningProposal,
} from '../domain/ports/source-learning.js';
import type { NormalizedMemorySubject } from './memory-types.js';
import type { AppMemoryService } from './app-memory-service.js';
import type {
  MemoryLlmClient,
  MemoryLlmUsage,
} from '../domain/ports/memory-llm-client.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import { PostgresSourceLearningRepository } from '../adapters/storage/postgres/repositories/source-learning-repository.postgres.js';
import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import { getMemoryLlmClient } from './memory-llm-port.js';
import {
  validateSourceLearningProposal,
  SOURCE_LEARNING_VALIDATOR_VERSION,
} from './source-learning-validation.js';
import { normalizeModelUsage } from '../shared/model-usage.js';
import { resolveModelSelectionForWorkload } from '../shared/model-catalog.js';
export async function saveSourceLearning(input: {
  scope: SourceLearningScope;
  proposal: SourceLearningProposal;
  subject: NormalizedMemorySubject;
  memory: AppMemoryService;
  requestDeadlineAtMs?: number;
  repository?: PostgresSourceLearningRepository;
  client?: MemoryLlmClient;
  publish?: (event: RuntimeEventPublishInput) => Promise<unknown> | unknown;
}) {
  const repository =
    input.repository ??
    new PostgresSourceLearningRepository(getRuntimeStorage().service.db);
  const context = await repository.context(input.scope, input.subject);
  context.deadlineAtMs = Math.min(
    context.deadlineAtMs,
    input.requestDeadlineAtMs ?? Infinity,
  );
  const holder = randomUUID();
  if (!(await repository.acquire(context, holder)))
    throw new Error('Another learning check is in progress; retry shortly');
  let candidateId: string | undefined;
  let latestUsage: MemoryLlmUsage | undefined;
  let usageRecorded = false;
  const persistUsage = async () => {
    if (usageRecorded) return;
    if (candidateId && latestUsage) {
      const model = resolveModelSelectionForWorkload(
        context.request.model,
        'chat',
      );
      const usage = normalizeModelUsage({
        message: { usage: latestUsage },
        fallbackModel: model.ok
          ? model.entry.runnerModel
          : context.request.model,
      });
      if (usage) {
        await repository.audit(candidateId, {
          validatorUsage: usage,
          validatorUsageEventId: `${candidateId}:validator`,
        });
        const publish =
          input.publish ??
          ((event: RuntimeEventPublishInput) =>
            getRuntimeStorage().runtimeEvents.publish(event));
        await publish({
          appId: input.scope.appId as never,
          agentId: input.scope.agentId as never,
          sessionId: context.sessionId as never,
          runId: input.scope.runId as never,
          eventType: 'model.usage',
          actor: 'agent',
          correlationId: context.request.answerGoalId,
          payload: {
            usage,
            usageEventId: `${candidateId}:validator`,
            modelAlias: context.request.model,
            providerId: usage.provider,
            stage: 'source_learning_validation',
            candidateId,
          },
        });
      }
    }
    usageRecorded = true;
  };
  try {
    const candidate = await repository.stage(context, input.proposal);
    candidateId = candidate.id;
    let row = await repository.read(candidate.id);
    if (candidate.replayed && !['validated', 'active'].includes(row!.status))
      throw new Error(
        'This learning proposal was not activated; clarify with fresh human support',
      );
    if (!candidate.replayed) {
      await repository.authorize(
        candidate,
        'evidence',
        Math.min(context.deadlineAtMs, Date.now() + 10000),
      );
      let result;
      try {
        result = await validateSourceLearningProposal({
          candidateId: candidate.id,
          context,
          proposal: input.proposal,
          evidence: candidate.evidence,
          client: input.client ?? getMemoryLlmClient(),
          onUsage: (usage) => {
            latestUsage = usage;
          },
        });
      } catch (error) {
        await repository.decision(candidate.id, false, {
          validatorVersion: SOURCE_LEARNING_VALIDATOR_VERSION,
          decision: 'unavailable',
        });
        throw error;
      }
      await persistUsage();
      await repository.decision(candidate.id, result.allowed, {
        validatorVersion: SOURCE_LEARNING_VALIDATOR_VERSION,
        decision: result.verdict ?? { decision: 'uncertain' },
        validationModel: context.request.model,
      });
      if (!result.allowed) throw new Error(result.reason);
    }
    // Every activation, including a lost-ack replay, receives a newly checked grant.
    const publicationId = await repository.authorize(
      candidate,
      'publication',
      Math.min(context.deadlineAtMs, Date.now() + 10000),
    );
    row = await repository.read(candidate.id);
    return await input.memory.save({
      ...input.subject,
      kind: input.proposal.kind as never,
      key: input.proposal.key,
      value: input.proposal.value,
      why: 'Validated reusable human instruction',
      source: input.proposal.source,
      evidenceIds: JSON.parse(row!.evidenceIdsJson),
      actorId: 'source-learning-validator',
      isAdminWrite: false,
      sourceLearningWrite:
        input.proposal.source === 'discussion-explicit'
          ? 'explicit'
          : 'inferred',
      sourceLearningCandidateId: candidate.id,
      sourceLearningAuthorityId: publicationId,
    });
  } finally {
    try {
      await persistUsage();
    } finally {
      await repository.release(context, holder);
    }
  }
}

export async function forgetSourceLearning(input: {
  scope: SourceLearningScope;
  subject: NormalizedMemorySubject;
  id: string;
  expectedVersion?: number;
  repository?: PostgresSourceLearningRepository;
  requestDeadlineAtMs?: number;
}) {
  const repository =
    input.repository ??
    new PostgresSourceLearningRepository(getRuntimeStorage().service.db);
  const context = await repository.context(input.scope, input.subject);
  const authorityId = await repository.authorize(
    {
      id: `source-forget:${input.id}:${randomUUID()}`,
      context,
      evidence: [],
      replayed: false,
    },
    'publication',
    Math.min(
      context.deadlineAtMs,
      input.requestDeadlineAtMs ?? Infinity,
      Date.now() + 10000,
    ),
  );
  return repository.forget(
    context,
    input.id,
    input.expectedVersion,
    authorityId,
  );
}
