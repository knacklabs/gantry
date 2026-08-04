export const OBSERVER_INSIGHT_TYPES = [
    'commitment',
    'contradiction',
    'open_question',
    'stale_fact',
    'decision_without_owner',
    'duplicated_work',
    'repetition',
];
export const OBSERVER_INSIGHT_STATES = [
    'pending',
    'claimed',
    'sent',
    'cooldown',
    'resolved',
    'dropped',
];
export function isObserverSubjectKey(value) {
    if (/^msu_[a-f0-9]{32}$/.test(value) || value === 'observer:app') {
        return true;
    }
    if (!value.startsWith('conversation:'))
        return false;
    const conversationId = value.slice('conversation:'.length);
    return (conversationId.trim().length > 0 &&
        [...conversationId].every((character) => {
            const code = character.charCodeAt(0);
            return code > 0x1f && (code < 0x7f || code > 0x9f);
        }));
}
export const OBSERVER_DELIVERY_STATES = [
    'reserved',
    'sent',
    'settled',
    'failed',
];
