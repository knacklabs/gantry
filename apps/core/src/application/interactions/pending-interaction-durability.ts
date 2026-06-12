import type {
  RunLease,
  PendingInteractionKind,
  PendingInteractionRepository,
  RunLeaseRepository,
  TransientGrantRepository,
} from '../../domain/ports/worker-coordination.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  UserQuestionRequest,
} from '../../domain/types.js';
import { decisionForMode } from '../../domain/permission-decision.js';
import type {
  LiveTurnCommandRepository,
  LiveTurnRepository,
} from '../../domain/ports/live-turns.js';
import { nowMs, parseIso, toIso } from '../../shared/time/datetime.js';
import { enqueueResolvedInteractionCommand } from './pending-interaction-live-turn-delivery.js';
import {
  applyRecoveredPersistentPermissionGrant,
  type PermissionPersistenceBackend,
} from './pending-interaction-permission-recovery.js';
import {
  QUESTION_SELECTIONS_PAYLOAD_KEY,
  questionSelectionsFromPayload,
  serializeQuestionSelections,
} from './pending-interaction-question-selections.js';
const DEFAULT_INTERACTION_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_APP_ID = 'default';
type InteractionDurabilityRepository = PendingInteractionRepository &
  RunLeaseRepository &
  TransientGrantRepository;
type InteractionLiveTurnRepository = Pick<
  LiveTurnRepository,
  'findActiveLiveTurnByRunId'
> &
  Pick<LiveTurnCommandRepository, 'appendLiveTurnCommand'>;
interface InteractionDurabilityBackend {
  repository: InteractionDurabilityRepository;
  liveTurns?: InteractionLiveTurnRepository | null;
  warn?: (context: Record<string, unknown>, message: string) => void;
}
let backend: InteractionDurabilityBackend | null = null;
let permissionPersistence: PermissionPersistenceBackend | null = null;
/**
 * Wired by the storage runtime when Postgres comes up. Without a backend the
 * durability hooks no-op (storage-less local fallback).
 */
export function configurePendingInteractionDurability(
  next: InteractionDurabilityBackend | null,
): void {
  backend = next;
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
}): string {
  return [input.kind, input.sourceAgentFolder, input.requestId].join(':');
}

/**
 * Durable record for a permission/question prompt, created BEFORE the
 * provider prompt renders. Survives provider and control-plane restarts: the
 * idempotency key makes a restart-driven re-prompt reuse the same record.
 */
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
}): Promise<boolean> {
  const active = backend;
  if (!active) return true;
  try {
    await active.repository.createPendingInteraction({
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
    return true;
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
}): Promise<boolean> {
  const active = backend;
  if (!active) return true;
  const idempotencyKey = pendingInteractionIdempotencyKey(input);
  let liveTurnDelivery: {
    turnId: string;
    callbackRoute: Record<string, unknown>;
  } | null = null;

  if (input.runId && active.liveTurns) {
    try {
      const pending = (
        await active.repository.listPendingInteractions({
          appId: input.appId || DEFAULT_APP_ID,
          runId: input.runId,
        })
      ).find((interaction) => interaction.idempotencyKey === idempotencyKey);
      const turn = await active.liveTurns.findActiveLiveTurnByRunId({
        runId: input.runId,
      });
      if (turn && pending?.callbackRoute) {
        liveTurnDelivery = {
          turnId: turn.id,
          callbackRoute: pending.callbackRoute,
        };
      }
    } catch (err) {
      active.warn?.(
        {
          err,
          kind: input.kind,
          requestId: input.requestId,
          runId: input.runId,
        },
        'Failed to deliver interaction resolution to the owning live turn',
      );
      return false;
    }
  }

  // Persist the live-turn command before marking the pending row resolved. A
  // crash after the row transition must not leave the runner blocked with no
  // durable command to replay.
  if (input.runId && active.liveTurns && liveTurnDelivery) {
    try {
      const delivered = await enqueueResolvedInteractionCommand({
        liveTurns: active.liveTurns,
        turnId: liveTurnDelivery.turnId,
        idempotencyKey,
        kind: input.kind,
        requestId: input.requestId,
        sourceAgentFolder: input.sourceAgentFolder,
        status: input.status,
        resolution: input.resolution,
        callbackRoute: liveTurnDelivery.callbackRoute,
        approverRef: input.approverRef,
      });
      if (!delivered) {
        active.warn?.(
          { kind: input.kind, requestId: input.requestId, runId: input.runId },
          'Failed to enqueue interaction resolution to the owning live turn',
        );
        return false;
      }
    } catch (err) {
      active.warn?.(
        {
          err,
          kind: input.kind,
          requestId: input.requestId,
          runId: input.runId,
        },
        'Failed to deliver interaction resolution to the owning live turn',
      );
      return false;
    }
  }

  try {
    const resolved = await active.repository.resolvePendingInteraction({
      idempotencyKey,
      status: input.status,
      resolution: input.resolution,
      approverRef: input.approverRef ?? null,
    });
    if (!resolved) return false;
  } catch (err) {
    active.warn?.(
      { err, kind: input.kind, requestId: input.requestId },
      'Failed to resolve durable pending interaction',
    );
    return false;
  }
  return true;
}

export interface DurablePermissionInteractionContext {
  sourceAgentFolder: string;
  targetJid: string | null;
  decisionPolicy: string | null;
}

export async function findDurablePermissionInteractionByRequestId(input: {
  requestId: string;
  appId?: string | null;
}): Promise<DurablePermissionInteractionContext | null> {
  const active = backend;
  if (!active) return null;
  try {
    const pending = (
      await active.repository.listPendingInteractions({
        appId: input.appId || DEFAULT_APP_ID,
      })
    ).find(
      (interaction) =>
        interaction.kind === 'permission' &&
        interaction.status === 'pending' &&
        (interaction.payload?.requestId === input.requestId ||
          interaction.payload?.permissionCallbackId === input.requestId),
    );
    const sourceAgentFolder = sourceAgentFolderFromPendingPayload(
      pending?.payload,
    );
    if (!pending || !sourceAgentFolder) return null;
    return {
      sourceAgentFolder,
      targetJid:
        typeof pending.payload.conversationId === 'string'
          ? pending.payload.conversationId
          : null,
      decisionPolicy:
        typeof pending.payload.decisionPolicy === 'string'
          ? pending.payload.decisionPolicy
          : null,
    };
  } catch (err) {
    active.warn?.(
      { err, requestId: input.requestId },
      'Failed to find durable permission interaction',
    );
    return null;
  }
}

function sourceAgentFolderFromPendingPayload(
  payload: Record<string, unknown> | undefined,
): string | null {
  if (typeof payload?.sourceAgentFolder === 'string') {
    return payload.sourceAgentFolder;
  }
  const request = payload?.request;
  if (!request || typeof request !== 'object') return null;
  if (!('sourceAgentFolder' in request)) return null;
  if (typeof request.sourceAgentFolder !== 'string') return null;
  return request.sourceAgentFolder;
}

export async function resolveDurablePermissionInteractionByRequestId(input: {
  requestId: string;
  mode: PermissionApprovalDecisionMode;
  approverRef?: string | null;
  reason?: string | null;
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
        interaction.kind === 'permission' &&
        interaction.status === 'pending' &&
        (interaction.payload?.requestId === input.requestId ||
          interaction.payload?.permissionCallbackId === input.requestId),
    );
    const sourceAgentFolder =
      typeof pending?.payload?.sourceAgentFolder === 'string'
        ? pending.payload.sourceAgentFolder
        : null;
    if (!pending || !sourceAgentFolder) return false;
    const pendingRequestId =
      typeof pending.payload.requestId === 'string'
        ? pending.payload.requestId
        : input.requestId;
    const request =
      pending.payload.request &&
      typeof pending.payload.request === 'object' &&
      !Array.isArray(pending.payload.request)
        ? (pending.payload.request as PermissionApprovalRequest)
        : null;
    const decision: PermissionApprovalDecision = request
      ? decisionForMode(request, input.mode, input.approverRef ?? undefined)
      : ({
          approved: input.mode !== 'cancel',
          mode: input.mode,
          decidedBy: input.approverRef ?? undefined,
          reason: input.reason ?? undefined,
        } satisfies PermissionApprovalDecision);
    if (
      decision.approved &&
      decision.mode === 'allow_persistent_rule' &&
      decision.decisionClassification === 'user_permanent'
    ) {
      if (!request) return false;
      if (!permissionPersistence) return false;
      const persisted = await applyRecoveredPersistentPermissionGrant({
        persistence: permissionPersistence,
        request: {
          ...request,
          requestId: pendingRequestId,
          sourceAgentFolder,
        },
        sourceAgentFolder,
        decision,
      });
      if (!persisted) return false;
    }
    if (
      decision.approved &&
      decision.decisionClassification !== 'user_permanent' &&
      pending.runId
    ) {
      await recordRunScopedTransientGrant({
        appId,
        runId: pending.runId,
        runLeaseToken:
          typeof pending.payload.runLeaseToken === 'string'
            ? pending.payload.runLeaseToken
            : null,
        runLeaseFencingVersion:
          typeof pending.payload.runLeaseFencingVersion === 'number'
            ? pending.payload.runLeaseFencingVersion
            : null,
        grant: {
          toolName:
            typeof pending.payload.toolName === 'string'
              ? pending.payload.toolName
              : 'unknown',
          mode: input.mode,
          requestId: pendingRequestId,
        },
        expiresAtMs:
          typeof decision.timedGrantExpiresAtMs === 'number'
            ? decision.timedGrantExpiresAtMs
            : undefined,
      });
    }
    return await resolvePendingInteractionRecord({
      kind: 'permission',
      sourceAgentFolder,
      requestId: pendingRequestId,
      appId,
      runId: pending.runId,
      status: decision.mode === 'cancel' ? 'cancelled' : 'resolved',
      resolution: {
        approved: decision.approved,
        mode: decision.mode,
        reason: decision.reason ?? input.reason ?? null,
        updatedPermissions: decision.updatedPermissions ?? null,
        decisionClassification: decision.decisionClassification ?? null,
        timedGrantExpiresAtMs: decision.timedGrantExpiresAtMs ?? null,
      },
      approverRef: decision.decidedBy ?? input.approverRef ?? null,
    });
  } catch (err) {
    active.warn?.(
      { err, requestId: input.requestId },
      'Failed to resolve durable permission interaction',
    );
    return false;
  }
}

export interface DurableQuestionInteractionContext {
  sourceAgentFolder: string;
  targetJid: string | null;
  request: UserQuestionRequest | null;
}

export async function findDurableQuestionInteractionByRequestId(input: {
  requestId: string;
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
        interaction.payload?.requestId === input.requestId,
    );
    const sourceAgentFolder =
      typeof pending?.payload?.sourceAgentFolder === 'string'
        ? pending.payload.sourceAgentFolder
        : null;
    if (!pending || !sourceAgentFolder) return null;
    const request =
      pending.payload.request &&
      typeof pending.payload.request === 'object' &&
      !Array.isArray(pending.payload.request)
        ? (pending.payload.request as UserQuestionRequest)
        : null;
    return {
      sourceAgentFolder,
      targetJid:
        typeof pending.payload.targetJid === 'string'
          ? pending.payload.targetJid
          : null,
      request,
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
        interaction.payload?.requestId === input.requestId,
    );
    const sourceAgentFolder =
      typeof pending?.payload?.sourceAgentFolder === 'string'
        ? pending.payload.sourceAgentFolder
        : null;
    const request =
      pending?.payload.request &&
      typeof pending.payload.request === 'object' &&
      !Array.isArray(pending.payload.request)
        ? (pending.payload.request as UserQuestionRequest)
        : null;
    const question = request?.questions[input.questionIndex];
    if (!pending || !sourceAgentFolder || !request || !question) return false;

    const selections = questionSelectionsFromPayload(pending.payload);

    if (typeof input.optionIndex === 'number') {
      if (
        !Number.isInteger(input.optionIndex) ||
        input.optionIndex < 0 ||
        input.optionIndex >= question.options.length
      ) {
        return false;
      }
      const selected = selections.get(input.questionIndex) ?? new Set<number>();
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
      const persisted = await active.repository.updatePendingInteractionPayload(
        {
          idempotencyKey: pending.idempotencyKey,
          payload: {
            ...pending.payload,
            [QUESTION_SELECTIONS_PAYLOAD_KEY]:
              serializeQuestionSelections(selections),
          },
        },
      );
      if (!persisted) return false;
    }

    if (question.multiSelect && !input.finalize) return true;
    if (question.multiSelect && input.finalize) {
      selections.set(
        input.questionIndex,
        selections.get(input.questionIndex) ?? new Set<number>(),
      );
    }
    if (!request.questions.every((_, index) => selections!.has(index))) {
      return true;
    }

    const answers: Record<string, string | string[]> = {};
    for (let index = 0; index < request.questions.length; index += 1) {
      const currentQuestion = request.questions[index]!;
      const selected = selections.get(index) ?? new Set<number>();
      const labels = [...selected]
        .sort((a, b) => a - b)
        .map((selectedIndex) =>
          currentQuestion.options[selectedIndex]?.label?.trim(),
        )
        .filter((label): label is string => Boolean(label));
      if (currentQuestion.multiSelect) {
        answers[currentQuestion.question] = labels;
      } else if (labels[0]) {
        answers[currentQuestion.question] = labels[0];
      }
    }
    const resolved = await resolvePendingInteractionRecord({
      kind: 'question',
      sourceAgentFolder,
      requestId: input.requestId,
      appId,
      runId: pending.runId,
      status: 'resolved',
      resolution: { answers },
      approverRef: input.answeredBy ?? null,
    });
    return resolved;
  } catch (err) {
    active.warn?.(
      { err, requestId: input.requestId },
      'Failed to resolve durable question interaction',
    );
    return false;
  }
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

/**
 * Transient, run-scoped authority: bound to the run's active lease and
 * expiring with it. Never written to durable permission state.
 */
export async function recordRunScopedTransientGrant(input: {
  appId?: string | null;
  runId: string;
  runLeaseToken?: string | null;
  runLeaseFencingVersion?: number | null;
  grant: Record<string, unknown>;
  expiresAtMs?: number;
}): Promise<void> {
  const active = backend;
  if (!active) return;
  try {
    const lease = await activeRunLeaseForInteraction(input);
    if (!lease) return;
    const leaseToken = input.runLeaseToken;
    if (!leaseToken) return;
    const leaseExpiryMs =
      parseIso(lease.expiresAt)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const expiresAtMs = Math.min(
      input.expiresAtMs ?? leaseExpiryMs,
      leaseExpiryMs,
    );
    await active.repository.createTransientGrant({
      id: globalThis.crypto.randomUUID(),
      appId: input.appId || DEFAULT_APP_ID,
      runId: input.runId,
      leaseToken,
      grant: input.grant,
      expiresAt: toIso(expiresAtMs),
    });
  } catch (err) {
    active.warn?.(
      { err, runId: input.runId },
      'Failed to record run-scoped transient grant',
    );
  }
}
