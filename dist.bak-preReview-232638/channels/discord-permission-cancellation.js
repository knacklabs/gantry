import { pendingPermissionAliasesForCancellation, RUNNER_CANCELLED_PERMISSION_REASON, } from './interaction-settlement.js';
export async function cancelPendingDiscordPermission(pendingPermissions, cancellation, settle) {
    const aliases = pendingPermissionAliasesForCancellation(pendingPermissions, cancellation);
    if (aliases.length === 0)
        return 'not_found';
    for (const providerAlias of aliases) {
        const result = await settle(providerAlias, cancellation.reason ?? RUNNER_CANCELLED_PERMISSION_REASON);
        if (result === 'settled')
            return 'settled';
        if (result === 'retryable')
            return 'retryable';
    }
    return 'already_decided';
}
