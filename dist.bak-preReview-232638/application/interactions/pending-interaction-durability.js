import { IPC_INTERACTION_RETENTION_TTL_MS } from '../../shared/ipc-interaction-lifetime.js';
import { nowMs, toIso } from '../../shared/time/datetime.js';
import { applyPendingInteractionGrantDecision, } from './pending-interaction-grants.js';
import { configurePendingInteractionPromptBinding, readQuestionRecoveryEnvelope, } from './pending-interaction-prompt-binding.js';
import { configurePendingInteractionPermissionCallbacks } from './pending-interaction-permission-callback.js';
import { questionSelectionsFromPayload, serializeQuestionSelections, } from './pending-interaction-question-selections.js';
import { persistPendingInteractionResolution, } from './pending-interaction-resolution.js';
import { pendingInteractionIdempotencyKey } from './pending-interaction-idempotency.js';
export { DurableInteractionPersistenceError } from './pending-interaction-persistence-error.js';
const DEFAULT_APP_ID = 'default';
let backend = null;
let permissionPersistence = null;
export function configurePendingInteractionDurability(next) {
    backend = next;
    configurePendingInteractionPromptBinding(next);
    configurePendingInteractionPermissionCallbacks(next
        ? {
            repository: next.repository,
            applyDecision: applyPermissionInteractionDecision,
            resolve: resolvePendingInteractionRecord,
            resolveOutcome: resolvePendingInteractionRecordOutcome,
            ...(next.warn ? { warn: next.warn } : {}),
        }
        : null);
}
export function configurePendingInteractionPermissionPersistence(next) {
    permissionPersistence = next;
}
export { pendingInteractionIdempotencyKey } from './pending-interaction-idempotency.js';
export async function recordPendingInteractionRequested(input) {
    const active = backend;
    if (!active)
        return true;
    try {
        return await active.repository.createPendingInteraction({
            id: input.interactionId ?? globalThis.crypto.randomUUID(),
            appId: input.appId || DEFAULT_APP_ID,
            runId: input.runId ?? null,
            sourceAgentFolder: input.sourceAgentFolder,
            requestId: input.requestId,
            runLeaseToken: input.runLeaseToken ?? null,
            runLeaseFencingVersion: input.runLeaseFencingVersion ?? null,
            kind: input.kind,
            payload: input.kind === 'question'
                ? {
                    ...input.payload,
                    sourceAgentFolder: input.sourceAgentFolder,
                    requestId: input.requestId,
                }
                : input.payload,
            callbackRoute: input.callbackRoute ?? null,
            idempotencyKey: pendingInteractionIdempotencyKey(input),
            expiresAt: toIso(nowMs() + (input.ttlMs ?? IPC_INTERACTION_RETENTION_TTL_MS)),
        });
    }
    catch (err) {
        active.warn?.({ err, kind: input.kind, requestId: input.requestId }, 'Failed to record durable pending interaction');
        throw err;
    }
}
export async function cancelPendingQuestionInteractionIfRunLeaseInactive(input) {
    const active = backend;
    if (!active)
        return true;
    return active.repository.cancelPendingQuestionInteractionIfRunLeaseInactive(input);
}
export async function resolvePendingInteractionRecordOutcome(input) {
    const active = backend;
    if (!active)
        return 'resolved';
    return persistPendingInteractionResolution(active, {
        ...input,
        appId: input.appId || DEFAULT_APP_ID,
        idempotencyKey: pendingInteractionIdempotencyKey(input),
    });
}
export async function resolvePendingInteractionRecord(input) {
    return (await resolvePendingInteractionRecordOutcome(input)) === 'resolved';
}
export { bindPendingPermissionInteractionMessage, findDurablePermissionInteractionByPromptMessage, } from './pending-interaction-prompt-binding.js';
export { claimPermissionInteractionCallback, findDurablePermissionInteractionByRequestId, replayPersistedPermissionDecisionForRequest, releasePermissionInteractionCallback, resolveDurablePermissionInteractionByRequestId, settlePermissionInteractionCallback, } from './pending-interaction-permission-callback.js';
export { recoverDurablePermissionDecision, } from './pending-interaction-permission-recovery-orchestrator.js';
export { samePermissionCallbackLocator } from './pending-interaction-permission-claim.js';
export function applyPermissionInteractionDecision(input) {
    return applyPendingInteractionGrantDecision(input, {
        permissionPersistence,
        recordRunScopedTransientGrant,
    });
}
async function findPendingQuestionRecord(active, appId, input) {
    return active.repository.findPendingInteractionByRequest({
        appId,
        kind: 'question',
        requestId: input.requestId,
        sourceAgentFolder: input.sourceAgentFolder,
    });
}
export async function resolveDurableQuestionInteractionByRequestId(input) {
    const active = backend;
    if (!active)
        return false;
    const appId = input.appId || DEFAULT_APP_ID;
    try {
        const pending = await findPendingQuestionRecord(active, appId, input);
        if (!pending)
            return false;
        return await persistQuestionProgress({
            pending,
            update: (envelope, payload) => {
                const question = envelope.request.questions[input.questionIndex];
                if (!question ||
                    (input.sourceAgentFolder &&
                        envelope.request.sourceAgentFolder !== input.sourceAgentFolder)) {
                    return null;
                }
                const selections = questionSelectionsFromPayload(payload);
                if (envelope.completedQuestionIndexes.includes(input.questionIndex)) {
                    return envelope;
                }
                if (typeof input.optionIndex === 'number') {
                    if (!Number.isInteger(input.optionIndex) ||
                        input.optionIndex < 0 ||
                        input.optionIndex >= question.options.length) {
                        return null;
                    }
                    const selected = selections.get(input.questionIndex) ?? new Set();
                    if (question.multiSelect) {
                        if (selected.has(input.optionIndex)) {
                            selected.delete(input.optionIndex);
                        }
                        else {
                            selected.add(input.optionIndex);
                        }
                    }
                    else {
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
                    selections.set(input.questionIndex, selections.get(input.questionIndex) ?? new Set());
                }
                return {
                    ...envelope,
                    selections: serializeQuestionSelections(selections),
                    completedQuestionIndexes: [
                        ...new Set([
                            ...envelope.completedQuestionIndexes,
                            input.questionIndex,
                        ]),
                    ].sort((a, b) => a - b),
                };
            },
        });
    }
    catch (err) {
        active.warn?.({ err, requestId: input.requestId }, 'Failed to resolve durable question interaction');
        return false;
    }
}
export async function recordDurableQuestionAnswerProgress(input) {
    const active = backend;
    if (!active)
        return false;
    const appId = input.appId || DEFAULT_APP_ID;
    const pending = await findPendingQuestionRecord(active, appId, input);
    if (!pending)
        return false;
    return persistQuestionProgress({
        pending,
        update: (envelope) => mergeQuestionAnswerProgress(envelope, input),
    });
}
function mergeQuestionAnswerProgress(envelope, input) {
    const answers = Object.fromEntries(Object.entries(input.answers).filter(([answerKey]) => envelope.request.questions.some((question, index) => question.question === answerKey &&
        !envelope.completedQuestionIndexes.includes(index))));
    return {
        ...envelope,
        completedQuestionIndexes: [
            ...new Set([
                ...envelope.completedQuestionIndexes,
                ...envelope.request.questions.flatMap((question, index) => Object.hasOwn(answers, question.question) ? [index] : []),
                ...(input.completedQuestionIndexes ?? []),
            ]),
        ].sort((a, b) => a - b),
    };
}
async function persistQuestionProgress(input) {
    const active = backend;
    if (!active)
        return false;
    let updated = false;
    const persisted = await active.repository.updatePendingInteractionPayload({
        idempotencyKey: input.pending.idempotencyKey,
        update: (payload) => {
            const envelope = readQuestionRecoveryEnvelope(payload.questionRecoveryEnvelope);
            if (!envelope)
                return null;
            const next = input.update(envelope, payload);
            if (!next)
                return null;
            updated = true;
            return {
                ...payload,
                questionRecoveryEnvelope: next,
            };
        },
    });
    return persisted && updated;
}
export async function isActiveRunLeaseForInteraction(input) {
    if (!input.runId)
        return true;
    return (await activeRunLeaseForInteraction(input)) !== null;
}
async function activeRunLeaseForInteraction(input) {
    if (!input.runId)
        return null;
    if (!input.runLeaseToken ||
        typeof input.runLeaseFencingVersion !== 'number') {
        return null;
    }
    const active = backend;
    if (!active)
        return null;
    try {
        const lease = await active.repository.getActiveRunLease({
            runId: input.runId,
        });
        if (!lease ||
            lease.leaseToken !== input.runLeaseToken ||
            lease.fencingVersion !== input.runLeaseFencingVersion) {
            return null;
        }
        return lease;
    }
    catch (err) {
        active.warn?.({ err, runId: input.runId }, 'Failed to validate active run lease for interaction');
        return null;
    }
}
export async function recordRunScopedTransientGrant(input) {
    const active = backend;
    if (!active)
        return;
    try {
        const lease = await activeRunLeaseForInteraction(input);
        if (!lease)
            return;
        const leaseToken = input.runLeaseToken;
        if (!leaseToken)
            return;
        await active.repository.createTransientGrant({
            id: globalThis.crypto.randomUUID(),
            appId: input.appId || DEFAULT_APP_ID,
            runId: input.runId,
            leaseToken,
            grant: input.grant,
            expiresAt: lease.expiresAt,
        });
    }
    catch (err) {
        active.warn?.({ err, runId: input.runId }, 'Failed to record run-scoped transient grant');
    }
}
