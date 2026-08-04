import type { SessionAppRecord } from '../../application/sessions/session-interaction-module.js';
/**
 * API decision names for permission interactions. Exactly three by product
 * decision: no timed grants.
 */
export declare const SESSION_INTERACTION_DECISIONS: readonly ["allow_once", "allow_future", "deny"];
export type SessionInteractionDecision = (typeof SESSION_INTERACTION_DECISIONS)[number];
export type SessionPendingInteractionView = {
    id: string;
    kind: 'permission' | 'question';
    createdAt: string;
    expiresAt: string;
    runId: string | null;
    toolName: string | null;
    /** Redacted command preview from the durable payload, when present. */
    summary: string | null;
    questions: string[] | null;
    options: SessionInteractionDecision[];
};
export declare function listSessionPendingInteractions(session: SessionAppRecord): Promise<{
    interactions: SessionPendingInteractionView[];
}>;
export type SessionInteractionRespondOutcome = {
    status: 'resolved';
    interactionId: string;
    decision: SessionInteractionDecision;
    decidedBy: string;
} | {
    status: 'not_found';
} | {
    status: 'already_resolved';
} | {
    status: 'question_unsupported';
} | {
    status: 'batch_unsupported';
} | {
    status: 'option_unavailable';
    options: SessionInteractionDecision[];
} | {
    status: 'malformed';
} | {
    status: 'retryable';
};
/**
 * Decide a pending permission interaction through the SAME durable
 * claim → grant application → resolution chain the channel permission
 * callbacks use (pending-interaction-permission-callback.ts, the functions
 * behind provider-rendered actions and recoverDurablePermissionDecision). The
 * API introduces no new authority semantics: the callback claim CAS is the
 * single-decider gate, and grants/settings mirrors/receipts flow through
 * applyPendingInteractionGrantDecision exactly as for channel approvers.
 */
export declare function respondToSessionPermissionInteraction(input: {
    session: SessionAppRecord;
    interactionId: string;
    decision: SessionInteractionDecision;
    decidedBy: string;
}): Promise<SessionInteractionRespondOutcome>;
