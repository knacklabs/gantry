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
  UserQuestionRequest,
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
let questionRecoveryDispatcher:
  | ((request: UserQuestionRequest, startIndex: number) => Promise<void>)
  | null = null;

export function configureQuestionRecoveryDispatcher(
  dispatcher:
    | ((request: UserQuestionRequest, startIndex: number) => Promise<void>)
    | null,
): void {
  questionRecoveryDispatcher = dispatcher;
}
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
export function pendingInteractionIdempotencyKey(input: {
  kind: PendingInteractionKind;
  sourceAgentFolder: string;
  requestId: string;
  appId?: string | null;
}): string {
  return [
    input.appId || DEFAULT_APP_ID,
    input.kind,
    input.sourceAgentFolder,
    input.requestId,
  ].join(':');
}

export async function recordPendingInteractionRequested(input: {
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
      id: globalThis.crypto.randomUUID(),
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
  findDurableQuestionInteractionByCallbackId,
  findDurableQuestionOtherPrompt,
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

export interface DurableQuestionInteractionContext {
  sourceAgentFolder: string;
  targetJid: string | null;
  request: UserQuestionRequest | null;
}

export async function findDurableQuestionInteractionByRequestId(input: {
  requestId: string;
  sourceAgentFolder?: string;
  appId?: string | null;
}): Promise<DurableQuestionInteractionContext | null> {
  const active = backend;
  if (!active) return null;
  try {
    const pending = (
      await active.repository.listPendingInteractions({
        appId: input.appId || DEFAULT_APP_ID,
      })
    ).find(
      (interaction) =>
        interaction.kind === 'question' &&
        interaction.status === 'pending' &&
        interaction.payload?.requestId === input.requestId &&
        (!input.sourceAgentFolder ||
          interaction.payload?.sourceAgentFolder === input.sourceAgentFolder),
    );
    const envelope = readQuestionRecoveryEnvelope(
      pending?.payload.questionRecoveryEnvelope,
    );
    if (!pending || !envelope) return null;
    return {
      sourceAgentFolder: envelope.request.sourceAgentFolder,
      targetJid: envelope.targetJid,
      request: envelope.request,
    };
  } catch (err) {
    active.warn?.(
      { err, requestId: input.requestId },
      'Failed to find durable question interaction',
    );
    return null;
  }
}

export async function resolveDurableQuestionInteractionByRequestId(input: {
  requestId: string;
  sourceAgentFolder?: string;
  questionIndex: number;
  optionIndex?: number;
  finalize?: boolean;
  answeredBy?: string | null;
  appId?: string | null;
}): Promise<boolean> {
  const active = backend;
  if (!active) return false;
  const appId = input.appId || DEFAULT_APP_ID;
  try {
    const pending = (
      await active.repository.listPendingInteractions({ appId })
    ).find(
      (interaction) =>
        interaction.kind === 'question' &&
        interaction.status === 'pending' &&
        interaction.payload?.requestId === input.requestId &&
        (!input.sourceAgentFolder ||
          interaction.payload?.sourceAgentFolder === input.sourceAgentFolder),
    );
    if (!pending) return false;
    return await persistQuestionProgress({
      pending,
      answeredBy: input.answeredBy,
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
          return { envelope, advance: true };
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
            envelope: {
              ...envelope,
              selections: serializeQuestionSelections(selections),
            },
            advance: false,
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
          envelope: {
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
          },
          advance: true,
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

export async function resolveDurableQuestionAnswersByRequestId(input: {
  requestId: string;
  sourceAgentFolder?: string;
  answers: Record<string, string | string[]>;
  completedQuestionIndexes?: number[];
  answeredBy?: string | null;
  appId?: string | null;
}): Promise<boolean> {
  const active = backend;
  if (!active) return false;
  const appId = input.appId || DEFAULT_APP_ID;
  try {
    const pending = (
      await active.repository.listPendingInteractions({ appId })
    ).find(
      (interaction) =>
        interaction.kind === 'question' &&
        interaction.status === 'pending' &&
        interaction.payload?.requestId === input.requestId &&
        (!input.sourceAgentFolder ||
          interaction.payload?.sourceAgentFolder === input.sourceAgentFolder),
    );
    if (!pending) return false;
    return await persistQuestionProgress({
      pending,
      answeredBy: input.answeredBy,
      update: (envelope) => ({
        envelope: {
          ...envelope,
          answers: { ...envelope.answers, ...input.answers },
          completedQuestionIndexes: [
            ...new Set([
              ...envelope.completedQuestionIndexes,
              ...envelope.request.questions.flatMap((question, index) =>
                Object.prototype.hasOwnProperty.call(
                  input.answers,
                  question.question,
                )
                  ? [index]
                  : [],
              ),
              ...(input.completedQuestionIndexes ?? []),
            ]),
          ].sort((a, b) => a - b),
        },
        advance: true,
      }),
    });
  } catch (err) {
    active.warn?.(
      { err, requestId: input.requestId },
      'Failed to resolve durable question interaction answers',
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
  const pending = (
    await active.repository.listPendingInteractions({ appId })
  ).find(
    (interaction) =>
      interaction.kind === 'question' &&
      interaction.status === 'pending' &&
      interaction.payload.requestId === input.requestId &&
      interaction.payload.sourceAgentFolder === input.sourceAgentFolder,
  );
  if (!pending) return false;
  return active.repository.updatePendingInteractionPayload({
    idempotencyKey: pending.idempotencyKey,
    update: (payload) => {
      const envelope = readQuestionRecoveryEnvelope(
        payload.questionRecoveryEnvelope,
      );
      if (!envelope) return null;
      const answers = Object.fromEntries(
        Object.entries(input.answers).filter(
          ([answerKey]) =>
            !envelope.request.questions.some(
              (question, index) =>
                question.question === answerKey &&
                envelope.completedQuestionIndexes.includes(index),
            ),
        ),
      );
      const completedQuestionIndexes = [
        ...new Set([
          ...envelope.completedQuestionIndexes,
          ...envelope.request.questions.flatMap((question, index) =>
            Object.prototype.hasOwnProperty.call(answers, question.question)
              ? [index]
              : [],
          ),
          ...(input.completedQuestionIndexes ?? []),
        ]),
      ].sort((a, b) => a - b);
      const nextQuestionIndex = envelope.request.questions.findIndex(
        (_, index) => !completedQuestionIndexes.includes(index),
      );
      return questionPayload(payload, {
        ...envelope,
        answers: { ...envelope.answers, ...answers },
        completedQuestionIndexes,
        nextQuestionIndex: nextQuestionIndex < 0 ? null : nextQuestionIndex,
      });
    },
  });
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
    const pending = (
      await active.repository.listPendingInteractions({ appId })
    ).find(
      (interaction) =>
        interaction.kind === 'question' &&
        interaction.status === 'pending' &&
        interaction.payload.requestId === input.requestId &&
        interaction.payload.sourceAgentFolder === input.sourceAgentFolder,
    );
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
        return questionPayload(payload, {
          ...envelope,
          deliveredQuestionIndexes: [
            ...new Set([
              ...envelope.deliveredQuestionIndexes,
              ...input.questionIndexes,
            ]),
          ].sort((a, b) => a - b),
        });
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
  ) => { envelope: QuestionRecoveryEnvelope; advance: boolean } | null;
  answeredBy?: string | null;
}): Promise<boolean> {
  const active = backend;
  if (!active) return false;
  const state: {
    updated?: { envelope: QuestionRecoveryEnvelope; advance: boolean };
  } = {};
  const persisted = await active.repository.updatePendingInteractionPayload({
    idempotencyKey: input.pending.idempotencyKey,
    update: (payload) => {
      const envelope = readQuestionRecoveryEnvelope(
        payload.questionRecoveryEnvelope,
      );
      if (!envelope) return null;
      const result = input.update(envelope, payload);
      if (!result) return null;
      const nextQuestionIndex = result.envelope.request.questions.findIndex(
        (_, index) => !result.envelope.completedQuestionIndexes.includes(index),
      );
      state.updated = {
        advance: result.advance,
        envelope: {
          ...result.envelope,
          nextQuestionIndex: nextQuestionIndex < 0 ? null : nextQuestionIndex,
        },
      };
      return questionPayload(payload, state.updated.envelope);
    },
  });
  if (!persisted || !state.updated) return false;
  const nextEnvelope = state.updated.envelope;
  if (!state.updated.advance) return true;
  const nextIndex = nextEnvelope.nextQuestionIndex;
  if (nextIndex !== null) {
    const alreadyDispatched =
      nextEnvelope.deliveredQuestionIndexes.includes(nextIndex);
    if (!alreadyDispatched) {
      const dispatcher = questionRecoveryDispatcher;
      if (!dispatcher) return false;
      setImmediate(() => {
        void dispatcher(nextEnvelope.request, nextIndex).catch((err) => {
          active.warn?.(
            {
              err,
              requestId: nextEnvelope.request.requestId,
              nextQuestionIndex: nextIndex,
            },
            'Failed to dispatch the next durable question prompt',
          );
        });
      });
    }
    return true;
  }
  return resolvePendingInteractionRecord({
    kind: 'question',
    sourceAgentFolder: nextEnvelope.request.sourceAgentFolder,
    requestId: nextEnvelope.request.requestId,
    appId: nextEnvelope.request.appId || DEFAULT_APP_ID,
    runId: input.pending.runId,
    status: 'resolved',
    resolution: { answers: nextEnvelope.answers },
    approverRef: input.answeredBy ?? null,
  });
}

function questionPayload(
  payload: Record<string, unknown>,
  envelope: QuestionRecoveryEnvelope,
  patch?: Partial<QuestionRecoveryEnvelope>,
): Record<string, unknown> {
  return {
    ...payload,
    questionRecoveryEnvelope: { ...envelope, ...patch },
  };
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
