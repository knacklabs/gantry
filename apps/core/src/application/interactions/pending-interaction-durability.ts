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
import { nowMs, toIso } from '../../shared/time/datetime.js';
import { enqueueResolvedInteractionCommand } from './pending-interaction-live-turn-delivery.js';
import {
  applyPendingInteractionGrantDecision,
  type PermissionInteractionDecisionInput,
} from './pending-interaction-grants.js';
import type { PermissionPersistenceBackend } from './pending-interaction-permission-recovery.js';
import { configurePendingInteractionPromptBinding } from './pending-interaction-prompt-binding.js';
import type { DurablePermissionFullView } from './pending-interaction-prompt-binding.js';
import { readDurablePermissionFullView } from './pending-interaction-prompt-binding.js';
import {
  QUESTION_SELECTIONS_PAYLOAD_KEY,
  questionSelectionsFromPayload,
  serializeQuestionSelections,
} from './pending-interaction-question-selections.js';
const DEFAULT_INTERACTION_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_APP_ID = 'default';
const RESERVED_PERMISSION_DECIDERS = new Set([
  'runtime',
  'system',
  'auto_classifier',
]);
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
export function configurePendingInteractionDurability(
  next: InteractionDurabilityBackend | null,
): void {
  backend = next;
  configurePendingInteractionPromptBinding(next);
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
  threadId: string | null;
  decisionPolicy: string | null;
  fullView?: DurablePermissionFullView;
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
    const fullView = readDurablePermissionFullView(
      pending.payload.permissionFullView,
    );
    return {
      sourceAgentFolder,
      targetJid:
        typeof pending.payload.conversationId === 'string'
          ? pending.payload.conversationId
          : null,
      threadId:
        typeof pending.payload.threadId === 'string'
          ? pending.payload.threadId
          : typeof pending.payload.request === 'object' &&
              pending.payload.request !== null &&
              'threadId' in pending.payload.request &&
              typeof pending.payload.request.threadId === 'string'
            ? pending.payload.request.threadId
            : null,
      decisionPolicy:
        typeof pending.payload.decisionPolicy === 'string'
          ? pending.payload.decisionPolicy
          : null,
      ...(fullView ? { fullView } : {}),
    };
  } catch (err) {
    active.warn?.(
      { err, requestId: input.requestId },
      'Failed to find durable permission interaction',
    );
    return null;
  }
}
export {
  bindPendingPermissionInteractionMessage,
  findDurablePermissionInteractionByPromptMessage,
} from './pending-interaction-prompt-binding.js';
export type { DurablePermissionPromptMessageContext } from './pending-interaction-prompt-binding.js';

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
  if (
    input.mode !== 'cancel' &&
    !isConcretePermissionApproverIdentity(input.approverRef)
  ) {
    return false;
  }
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
    const applied = await applyPermissionInteractionDecision({
      request,
      sourceAgentFolder,
      decision,
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
      toolName:
        typeof pending.payload.toolName === 'string'
          ? pending.payload.toolName
          : 'unknown',
      requestId: pendingRequestId,
    });
    if (!applied) return false;
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

function isConcretePermissionApproverIdentity(
  approverRef: string | null | undefined,
): boolean {
  const normalized = approverRef?.trim().toLowerCase();
  return Boolean(normalized && !RESERVED_PERMISSION_DECIDERS.has(normalized));
}

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

export async function resolveDurableQuestionAnswersByRequestId(input: {
  requestId: string;
  answers: Record<string, string | string[]>;
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
    if (!pending || !sourceAgentFolder) return false;
    return await resolvePendingInteractionRecord({
      kind: 'question',
      sourceAgentFolder,
      requestId: input.requestId,
      appId,
      runId: pending.runId,
      status: 'resolved',
      resolution: { answers: input.answers },
      approverRef: input.answeredBy ?? null,
    });
  } catch (err) {
    active.warn?.(
      { err, requestId: input.requestId },
      'Failed to resolve durable question interaction answers',
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
