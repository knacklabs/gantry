import { listConnectableChannelProviders } from '../channels/provider-registry.js';
import { hasRuntimeCredentialConfigured } from './runtime-credential-check.js';
export function hasConfiguredChannelProvider(settings) {
    return listConnectableChannelProviders().some((provider) => settings.providers[provider.id]?.enabled);
}
export async function hasProcessableGroupForConfiguredChannelSettings(input) {
    for (const provider of listConnectableChannelProviders()) {
        if (!input.settings.providers[provider.id]?.enabled)
            continue;
        const hasRequiredCredentials = provider.setup.envKeys.every((envKey) => hasRuntimeCredentialConfigured({
            settings: input.settings,
            env: input.env,
            providerId: provider.id,
            envKey,
        }));
        if (!hasRequiredCredentials)
            continue;
        let db;
        try {
            db = await input.openRuntimeGroupDb(input.runtimeHome);
            const count = await db.countConversationRoutesByJidPrefix(provider.jidPrefix);
            if (count > 0)
                return true;
        }
        catch {
            continue;
        }
        finally {
            await db?.close();
        }
    }
    return false;
}
