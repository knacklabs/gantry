export function permissionDecisionExpiresAt(decision, now) {
    if (!decision.approved)
        return undefined;
    if (decision.mode === 'allow_once')
        return now;
    return undefined;
}
