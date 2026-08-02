import { firstPersistentRule } from '../../domain/permission-decision.js';
import { bindPendingPermissionInteractionMessage, claimPermissionInteractionCallback, resolveDurablePermissionInteractionByRequestId, } from '../../application/interactions/pending-interaction-durability.js';
import { permissionRequestFromPayload } from '../../application/interactions/pending-interaction-permission-envelope.js';
import { getWorkerCoordinationRepository } from '../../adapters/storage/postgres/runtime-store.js';
/**
 * API decision names for permission interactions. Exactly three by product
 * decision: no timed grants.
 */
export const SESSION_INTERACTION_DECISIONS = [
    'allow_once',
    'allow_future',
    'deny',
];
const DECISION_TO_MODE = {
    allow_once: 'allow_once',
    allow_future: 'allow_persistent_rule',
    deny: 'cancel',
};
const MODE_TO_DECISION = {
    allow_once: 'allow_once',
    allow_persistent_rule: 'allow_future',
    cancel: 'deny',
};
function sessionInteractionTargetJid(row) {
    const request = permissionRequestFromPayload(row.payload);
    if (request?.targetJid)
        return request.targetJid;
    const targetJid = row.payload.targetJid;
    return typeof targetJid === 'string' ? targetJid : null;
}
/**
 * The same option ladder the channel permission requester renders
 * (ipc-permission-classifier-decision.ts): explicit decisionOptions win,
 * otherwise allow_future is only offered when a persistable rule exists.
 */
function permissionDecisionModes(request) {
    if (!request)
        return ['allow_once', 'cancel'];
    if (request.decisionOptions?.length)
        return request.decisionOptions;
    return firstPersistentRule(request)
        ? ['allow_once', 'allow_persistent_rule', 'cancel']
        : ['allow_once', 'cancel'];
}
function apiDecisionOptions(modes) {
    return SESSION_INTERACTION_DECISIONS.filter((decision) => modes.includes(DECISION_TO_MODE[decision]));
}
function belongsToSession(row, session) {
    return (row.sourceAgentFolder === session.workspaceKey &&
        sessionInteractionTargetJid(row) === session.conversationJid);
}
export async function listSessionPendingInteractions(session) {
    const repository = getWorkerCoordinationRepository();
    const rows = await repository.listPendingInteractions({
        appId: session.appId,
    });
    const interactions = rows
        .filter((row) => (row.kind === 'permission' || row.kind === 'question') &&
        typeof row.requestId === 'string' &&
        belongsToSession(row, session))
        .map((row) => {
        const request = permissionRequestFromPayload(row.payload);
        const questions = Array.isArray(row.payload.questions)
            ? row.payload.questions.filter((question) => typeof question === 'string')
            : null;
        return {
            id: row.requestId,
            kind: row.kind,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            runId: row.runId,
            toolName: row.kind === 'permission' ? (request?.toolName ?? null) : null,
            summary: row.kind === 'permission' &&
                typeof row.payload.commandPreview === 'string'
                ? row.payload.commandPreview
                : null,
            questions: row.kind === 'question' ? questions : null,
            options: row.kind === 'permission'
                ? apiDecisionOptions(permissionDecisionModes(request))
                : [],
        };
    });
    return { interactions };
}
/**
 * Decide a pending permission interaction through the SAME durable
 * claim → grant application → resolution chain the channel permission
 * callbacks use (pending-interaction-permission-callback.ts, the functions
 * behind provider-rendered actions and recoverDurablePermissionDecision). The
 * API introduces no new authority semantics: the callback claim CAS is the
 * single-decider gate, and grants/settings mirrors/receipts flow through
 * applyPendingInteractionGrantDecision exactly as for channel approvers.
 */
export async function respondToSessionPermissionInteraction(input) {
    const { session, interactionId } = input;
    const repository = getWorkerCoordinationRepository();
    const mode = DECISION_TO_MODE[input.decision];
    const scopeBase = {
        appId: session.appId,
        sourceAgentFolder: session.workspaceKey,
    };
    const row = await repository.findPendingInteractionByRequest({
        ...scopeBase,
        kind: 'permission',
        requestId: interactionId,
    });
    if (!row || !belongsToSession(row, session)) {
        const question = await repository.findPendingInteractionByRequest({
            ...scopeBase,
            kind: 'question',
            requestId: interactionId,
        });
        if (question && belongsToSession(question, session)) {
            return { status: 'question_unsupported' };
        }
        const terminal = await repository.findPendingPermissionPrompt({
            scope: { ...scopeBase, interactionId },
            includeTerminalSettlement: true,
        });
        return terminal ? { status: 'already_resolved' } : { status: 'not_found' };
    }
    let group = await repository.findPendingPermissionPromptByMember({
        ...scopeBase,
        requestId: interactionId,
    });
    if (!group) {
        // Headless prompts never rendered on a channel have no durable prompt
        // binding yet. Bind one exactly as channel deliveries do before their
        // callbacks become answerable through the durable interaction seam.
        const request = permissionRequestFromPayload(row.payload);
        if (!request)
            return { status: 'malformed' };
        await bindPendingPermissionInteractionMessage({
            request,
            decisionOptions: permissionDecisionModes(request),
            provider: 'api',
            conversationId: session.conversationId,
        });
        group = await repository.findPendingPermissionPromptByMember({
            ...scopeBase,
            requestId: interactionId,
        });
        if (!group)
            return { status: 'retryable' };
    }
    if (group.prompt.matchKind !== 'individual' ||
        group.prompt.interactionId !== interactionId) {
        // ponytail: batch prompts stay channel-only in v1 — deciding one member
        // via the API would settle the whole channel-rendered batch.
        return { status: 'batch_unsupported' };
    }
    const renderedModes = group.prompt.envelope.renderedDecisionOptions;
    if (!renderedModes.includes(mode)) {
        return {
            status: 'option_unavailable',
            options: apiDecisionOptions(renderedModes),
        };
    }
    // No providerAlias: aliases route provider-specific channel callbacks, and
    // the claim CAS requires a passed alias to already be bound on the prompt.
    const claimed = await claimPermissionInteractionCallback({
        scope: { ...scopeBase, interactionId },
        mode,
        approverRef: input.decidedBy,
        matchKind: 'individual',
    });
    if (claimed.status === 'already_decided')
        return { status: 'already_resolved' };
    if (claimed.status === 'retryable')
        return { status: 'retryable' };
    const resolved = await resolveDurablePermissionInteractionByRequestId({
        claim: claimed.claim,
    });
    if (!resolved)
        return { status: 'retryable' };
    const persistedMode = claimed.persistedClaim?.intent.mode ?? mode;
    return {
        status: 'resolved',
        interactionId,
        decision: MODE_TO_DECISION[persistedMode] ?? input.decision,
        decidedBy: claimed.persistedClaim?.intent.approverRef ?? input.decidedBy,
    };
}
