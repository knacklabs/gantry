/**
 * Durable live interactive turn contract. A live turn is the cross-worker
 * ownership record for one interactive conversation turn; commands are the
 * owner's durable inbox so continuation/stop/prompt traffic that lands on a
 * non-owner worker still reaches the worker that holds the runner process.
 */
function scopeComponent(value) {
    const trimmed = (value ?? '').trim();
    return encodeURIComponent(trimmed);
}
/**
 * Deterministic scope key for `(appId, agentSessionId, conversationId,
 * threadId)`. Components are URI-encoded so delimiter characters in ids can
 * never collide two scopes; null, undefined, and empty/whitespace components
 * normalize to the same key.
 */
export function makeLiveTurnScopeKey(scope) {
    return [
        'live',
        `app:${scopeComponent(scope.appId)}`,
        `session:${scopeComponent(scope.agentSessionId)}`,
        `conv:${scopeComponent(scope.conversationId)}`,
        `thread:${scopeComponent(scope.threadId)}`,
    ].join('|');
}
export const LIVE_TURN_TERMINAL_STATES = [
    'completed',
    'failed',
    'timed_out',
];
export function isTerminalLiveTurnState(state) {
    return LIVE_TURN_TERMINAL_STATES.includes(state);
}
export const LIVE_ADMISSION_TERMINAL_STATES = [
    'completed',
    'failed',
    'canceled',
];
