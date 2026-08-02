const RESERVED_PERMISSION_DECIDERS = new Set([
    'runtime',
    'system',
    'auto_classifier',
]);
export function samePermissionCallbackLocator(left, right) {
    return (left.providerAlias === right.providerAlias &&
        left.matchKind === right.matchKind &&
        left.scope.appId === right.scope.appId &&
        left.scope.sourceAgentFolder === right.scope.sourceAgentFolder &&
        left.scope.interactionId === right.scope.interactionId);
}
export function permissionClaimReference(claim) {
    return { id: claim.id, scope: claim.scope };
}
export function samePermissionClaim(claim, reference) {
    return (claim.id === reference.id &&
        claim.scope.appId === reference.scope.appId &&
        claim.scope.sourceAgentFolder === reference.scope.sourceAgentFolder &&
        claim.scope.interactionId === reference.scope.interactionId);
}
export function isAllowedPermissionApproverIdentity(mode, approverRef) {
    const normalized = approverRef.trim().toLowerCase();
    return Boolean(normalized &&
        (mode === 'cancel' || !RESERVED_PERMISSION_DECIDERS.has(normalized)));
}
