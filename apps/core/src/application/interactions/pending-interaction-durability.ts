import type {
  PendingInteraction,
  RunLease,
  PendingInteractionKind,
  PendingInteractionRepository,
  RunLeaseRepository,
  TransientGrantRepository,
} from '../../domain/ports/worker-coordination.js';
import type {
  PermissionCallbackClaimReference,
  QuestionRecoveryEnvelope,
} from '../../domain/types.js';
import { nowMs, toIso } from '../../shared/time/datetime.js';
import {
  applyPendingInteractionGrantDecision,
  type PermissionInteractionDecisionInput,
} from './pending-interaction-grants.js';
import type { PermissionPersistenceBackend } from './pending-interaction-permission-recovery.js';
import {
  configurePendingInteractionPromptBinding,
  readQuestionRecoveryEnvelope,
} from './pending-interaction-prompt-binding.js';
import { configurePendingInteractionPermissionCallbacks } from './pending-interaction-permission-callback.js';
import {
  questionSelectionsFromPayload,
  serializeQuestionSelections,
} from './pending-interaction-question-selections.js';
import { DurableInteractionPersistenceError } from './pending-interaction-persistence-error.js';
import {
  persistPendingInteractionResolution,
  type PendingInteractionResolutionBackend,
} from './pending-interaction-resolution.js';
import { pendingInteractionIdempotencyKey } from './pending-interaction-idempotency.js';

export { DurableInteractionPersistenceError } from './pending-interaction-persistence-error.js';
const DEFAULT_INTERACTION_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_APP_ID = 'default';
type InteractionDurabilityRepository = PendingInteractionRepository &
  RunLeaseRepository &
  TransientGrantRepository;
interface InteractionDurabilityBackend extends PendingInteractionResolutionBackend {
  repository: InteractionDurabilityRepository;
}
let backend: InteractionDurabilityBackend | null = null;
let permissionPersistence: PermissionPersistenceBackend | null = null;
export function configurePendingInteractionDurability(
  next: InteractionDurabilityBackend | null,
): void {
  backend = next;
  configurePendingInteractionPromptBinding(next);
  configurePendingInteractionPermissionCallbacks(
    next
      ? {
          repository: next.repository,
          applyDecision: applyPermissionInteractionDecision,
          resolve: resolvePendingInteractionRecord,
          ...(next.warn ? { warn: next.warn } : {}),
        }
      : null,
  );
}
export function configurePendingInteractionPermissionPersistence(
  next: PermissionPersistenceBackend | null,
): void {
  permissionPersistence = next;
}
export { pendingInteractionIdempotencyKey } from './pending-interaction-idempotency.js';

export async function recordPendingInteractionRequested(input: {
  interactionId?: string;
  kind: PendingInteractionKind;
  sourceAgentFolder: string;
  requestId: string;
  appId?: string | null;
  runId?: string | null;
  runLeaseToken?: string | null;
  runLeaseFencingVersion?: number | null;
  payload: Record<string, unknown>;
  callbackRoute?: Record<string, unknown> | null;
  ttlMs?: number;
}): Promise<boolean | PendingInteraction> {
  const active = backend;
  if (!active) return true;
  try {
    return await active.repository.createPendingInteraction({
      id: input.interactionId ?? globalThis.crypto.randomUUID(),
      appId: input.appId || DEFAULT_APP_ID,
      runId: input.runId ?? null,
      kind: input.kind,
      payload: {
        ...input.payload,
        sourceAgentFolder: input.sourceAgentFolder,
        requestId: input.requestId,
        ...(input.runLeaseToken ? { runLeaseToken: input.runLeaseToken } : {}),
        ...(typeof input.runLeaseFencingVersion === 'number'
          ? { runLeaseFencingVersion: input.runLeaseFencingVersion }
          : {}),
      },
      callbackRoute: input.callbackRoute ?? null,
      idempotencyKey: pendingInteractionIdempotencyKey(input),
      expiresAt: toIso(nowMs() + (input.ttlMs ?? DEFAULT_INTERACTION_TTL_MS)),
    });
  } catch (err) {
    active.warn?.(
      { err, kind: input.kind, requestId: input.requestId },
      'Failed to record durable pending interaction',
    );
    throw err;
  }
}

export async function cancelPendingQuestionInteractionIfRunLeaseInactive(input: {
  id: string;
  resolution: Record<string, unknown>;
  now?: string;
}): Promise<boolean> {
  const active = backend;
  if (!active) return true;
  return active.repository.cancelPendingQuestionInteractionIfRunLeaseInactive(
    input,
  );
}

export async function resolvePendingInteractionRecord(input: {
  kind: PendingInteractionKind;
  sourceAgentFolder: string;
  requestId: string;
  appId?: string | null;
  runId?: string | null;
  status: 'resolved' | 'cancelled';
  resolution: Record<string, unknown>;
  approverRef?: string | null;
  permissionCallbackClaim?: PermissionCallbackClaimReference | null;
}): Promise<boolean> {
  const active = backend;
  if (!active) return true;
  return persistPendingInteractionResolution(active, {
    ...input,
    appId: input.appId || DEFAULT_APP_ID,
    idempotencyKey: pendingInteractionIdempotencyKey(input),
  });
}

export {
  bindPendingPermissionInteractionMessage,
  bindPendingQuestionInteractionCallback,
  bindPendingQuestionOtherPrompt,
  createDurableQuestionCallback,
  findDurablePermissionInteractionByPromptMessage,
} from './pending-interaction-prompt-binding.js';
export type {
  DurablePermissionPromptMessageContext,
  DurableQuestionCallback,
} from './pending-interaction-prompt-binding.js';
export {
  claimPermissionInteractionCallback,
  configurePermissionReviewEachDispatcher,
  findDurablePermissionInteractionByRequestId,
  replayPersistedPermissionDecisionForRequest,
  releasePermissionInteractionCallback,
  resolveDurablePermissionInteractionByRequestId,
  settlePermissionInteractionCallback,
} from './pending-interaction-permission-callback.js';
export type { DurablePermissionInteractionContext } from './pending-interaction-permission-callback.js';

export function applyPermissionInteractionDecision(
  input: PermissionInteractionDecisionInput,
): Promise<boolean> {
  return applyPendingInteractionGrantDecision(input, {
    permissionPersistence,
    recordRunScopedTransientGrant,
  });
}

async function findPendingQuestionRecord(
  active: InteractionDurabilityBackend,
  appId: string,
  input: { requestId: string; sourceAgentFolder?: string },
) {
  return (await active.repository.listPendingInteractions({ appId })).find(
    (interaction) =>
      interaction.kind === 'question' &&
      interaction.status === 'pending' &&
      interaction.payload?.requestId === input.requestId &&
      (!input.sourceAgentFolder ||
        interaction.payload?.sourceAgentFolder === input.sourceAgentFolder),
  );
}

export async function resolveDurableQuestionInteractionByRequestId(input: {
  requestId: string;
  sourceAgentFolder?: string;
  questionIndex: number;
  optionIndex?: number;
  finalize?: boolean;
  appId?: string | null;
}): Promise<boolean> {
  const active = backend;
  if (!active) return false;
  const appId = input.appId || DEFAULT_APP_ID;
  try {
    const pending = await findPendingQuestionRecord(active, appId, input);
    if (!pending) return false;
    return await persistQuestionProgress({
      pending,
      update: (envelope, payload) => {
        const question = envelope.request.questions[input.questionIndex];
        if (
          !question ||
          (input.sourceAgentFolder &&
            envelope.request.sourceAgentFolder !== input.sourceAgentFolder)
        ) {
          return null;
        }
        const selections = questionSelectionsFromPayload(payload);
        if (envelope.completedQuestionIndexes.includes(input.questionIndex)) {
          return envelope;
        }
        if (typeof input.optionIndex === 'number') {
          if (
            !Number.isInteger(input.optionIndex) ||
            input.optionIndex < 0 ||
            input.optionIndex >= question.options.length
          ) {
            return null;
          }
          const selected =
            selections.get(input.questionIndex) ?? new Set<number>();
          if (question.multiSelect) {
            if (selected.has(input.optionIndex)) {
              selected.delete(input.optionIndex);
            } else {
              selected.add(input.optionIndex);
            }
          } else {
            selected.clear();
            selected.add(input.optionIndex);
          }
          selections.set(input.questionIndex, selected);
        }
        if (question.multiSelect && !input.finalize) {
          return {
            ...envelope,
            selections: serializeQuestionSelections(selections),
          };
        }
        if (question.multiSelect) {
          selections.set(
            input.questionIndex,
            selections.get(input.questionIndex) ?? new Set<number>(),
          );
        }
        const selected =
          selections.get(input.questionIndex) ?? new Set<number>();
        const labels = [...selected]
          .sort((a, b) => a - b)
          .map((index) => question.options[index]?.label?.trim())
          .filter((label): label is string => Boolean(label));
        return {
          ...envelope,
          selections: serializeQuestionSelections(selections),
          answers: {
            ...envelope.answers,
            [question.question]: question.multiSelect
              ? labels
              : (labels[0] ?? ''),
          },
          completedQuestionIndexes: [
            ...new Set([
              ...envelope.completedQuestionIndexes,
              input.questionIndex,
            ]),
          ].sort((a, b) => a - b),
        };
      },
    });
  } catch (err) {
    active.warn?.(
      { err, requestId: input.requestId },
      'Failed to resolve durable question interaction',
    );
    return false;
  }
}

export async function recordDurableQuestionAnswerProgress(input: {
  requestId: string;
  sourceAgentFolder: string;
  answers: Record<string, string | string[]>;
  completedQuestionIndexes?: number[];
  appId?: string | null;
}): Promise<boolean> {
  const active = backend;
  if (!active) return false;
  const appId = input.appId || DEFAULT_APP_ID;
  const pending = await findPendingQuestionRecord(active, appId, input);
  if (!pending) return false;
  return persistQuestionProgress({
    pending,
    update: (envelope) => mergeQuestionAnswerProgress(envelope, input),
  });
}

function mergeQuestionAnswerProgress(
  envelope: QuestionRecoveryEnvelope,
  input: {
    answers: Record<string, string | string[]>;
    completedQuestionIndexes?: number[];
  },
): QuestionRecoveryEnvelope {
  const answers = Object.fromEntries(
    Object.entries(input.answers).filter(([answerKey]) =>
      envelope.request.questions.some(
        (question, index) =>
          question.question === answerKey &&
          !envelope.completedQuestionIndexes.includes(index),
      ),
    ),
  );
  return {
    ...envelope,
    answers: { ...envelope.answers, ...answers },
    completedQuestionIndexes: [
      ...new Set([
        ...envelope.completedQuestionIndexes,
        ...envelope.request.questions.flatMap((question, index) =>
          Object.hasOwn(answers, question.question) ? [index] : [],
        ),
        ...(input.completedQuestionIndexes ?? []),
      ]),
    ].sort((a, b) => a - b),
  };
}

export async function recordDurableQuestionPromptDelivered(input: {
  requestId: string;
  sourceAgentFolder: string;
  questionIndexes: number[];
  appId?: string | null;
}): Promise<boolean> {
  const active = backend;
  if (!active) {
    throw new DurableInteractionPersistenceError(
      'Pending question delivery persistence is unavailable',
    );
  }
  try {
    const appId = input.appId || DEFAULT_APP_ID;
    const pending = await findPendingQuestionRecord(active, appId, input);
    if (!pending) {
      throw new DurableInteractionPersistenceError(
        'Pending question delivery record is missing',
      );
    }
    const updated = await active.repository.updatePendingInteractionPayload({
      idempotencyKey: pending.idempotencyKey,
      update: (payload) => {
        const envelope = readQuestionRecoveryEnvelope(
          payload.questionRecoveryEnvelope,
        );
        if (!envelope) return null;
        return {
          ...payload,
          questionRecoveryEnvelope: {
            ...envelope,
            deliveredQuestionIndexes: [
              ...new Set([
                ...envelope.deliveredQuestionIndexes,
                ...input.questionIndexes,
              ]),
            ].sort((a, b) => a - b),
          },
        };
      },
    });
    if (!updated) {
      throw new DurableInteractionPersistenceError(
        'Pending question delivery record could not be updated',
      );
    }
    return true;
  } catch (err) {
    if (err instanceof DurableInteractionPersistenceError) throw err;
    throw new DurableInteractionPersistenceError(
      'Pending question delivery could not be persisted',
      err,
    );
  }
}

async function persistQuestionProgress(input: {
  pending: Awaited<
    ReturnType<PendingInteractionRepository['listPendingInteractions']>
  >[number];
  update: (
    envelope: QuestionRecoveryEnvelope,
    payload: Record<string, unknown>,
  ) => QuestionRecoveryEnvelope | null;
}): Promise<boolean> {
  const active = backend;
  if (!active) return false;
  let updated = false;
  const persisted = await active.repository.updatePendingInteractionPayload({
    idempotencyKey: input.pending.idempotencyKey,
    update: (payload) => {
      const envelope = readQuestionRecoveryEnvelope(
        payload.questionRecoveryEnvelope,
      );
      if (!envelope) return null;
      const next = input.update(envelope, payload);
      if (!next) return null;
      updated = true;
      return {
        ...payload,
        questionRecoveryEnvelope: next,
      };
    },
  });
  return persisted && updated;
}

export async function isActiveRunLeaseForInteraction(input: {
  runId?: string | null;
  runLeaseToken?: string | null;
  runLeaseFencingVersion?: number | null;
}): Promise<boolean> {
  if (!input.runId) return true;
  return (await activeRunLeaseForInteraction(input)) !== null;
}

async function activeRunLeaseForInteraction(input: {
  runId?: string | null;
  runLeaseToken?: string | null;
  runLeaseFencingVersion?: number | null;
}): Promise<RunLease | null> {
  if (!input.runId) return null;
  if (
    !input.runLeaseToken ||
    typeof input.runLeaseFencingVersion !== 'number'
  ) {
    return null;
  }
  const active = backend;
  if (!active) return null;
  try {
    const lease = await active.repository.getActiveRunLease({
      runId: input.runId,
    });
    if (
      !lease ||
      lease.leaseToken !== input.runLeaseToken ||
      lease.fencingVersion !== input.runLeaseFencingVersion
    ) {
      return null;
    }
    return lease;
  } catch (err) {
    active.warn?.(
      { err, runId: input.runId },
      'Failed to validate active run lease for interaction',
    );
    return null;
  }
}

export async function recordRunScopedTransientGrant(input: {
  appId?: string | null;
  runId: string;
  runLeaseToken?: string | null;
  runLeaseFencingVersion?: number | null;
  grant: Record<string, unknown>;
}): Promise<void> {
  const active = backend;
  if (!active) return;
  try {
    const lease = await activeRunLeaseForInteraction(input);
    if (!lease) return;
    const leaseToken = input.runLeaseToken;
    if (!leaseToken) return;
    await active.repository.createTransientGrant({
      id: globalThis.crypto.randomUUID(),
      appId: input.appId || DEFAULT_APP_ID,
      runId: input.runId,
      leaseToken,
      grant: input.grant,
      expiresAt: lease.expiresAt,
    });
  } catch (err) {
    active.warn?.(
      { err, runId: input.runId },
      'Failed to record run-scoped transient grant',
    );
  }
}
