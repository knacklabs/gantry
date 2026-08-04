import { getOptionalRuntimeSecret } from '../domain/ports/runtime-secret-provider.js';
export async function getProviderRuntimeSecret(input) {
    if (!input.providerAccountId)
        return '';
    const account = input.settings?.providerAccounts?.[input.providerAccountId];
    if (!account || account.provider !== input.providerId)
        return '';
    const ref = account.runtimeSecretRefs[input.key];
    if (!ref)
        return '';
    return (await getOptionalRuntimeSecret(input.secrets, { ref }))?.trim() || '';
}
