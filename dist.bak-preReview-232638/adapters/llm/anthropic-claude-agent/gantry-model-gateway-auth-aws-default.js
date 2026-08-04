import { defaultProvider } from '@aws-sdk/credential-provider-node';
const providers = new Map();
export async function getAwsDefaultChainCredentials(input) {
    const profile = input.profile?.trim();
    const key = profile || '<default>';
    let provider = providers.get(key);
    if (!provider) {
        provider = defaultProvider(profile ? { profile } : {});
        providers.set(key, provider);
    }
    const credentials = await provider();
    if (!credentials.accessKeyId || !credentials.secretAccessKey) {
        throw new Error('AWS default credential chain did not return credentials.');
    }
    return {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        ...(credentials.sessionToken
            ? { sessionToken: credentials.sessionToken }
            : {}),
    };
}
export function clearAwsDefaultCredentialProviderCacheForTest() {
    providers.clear();
}
