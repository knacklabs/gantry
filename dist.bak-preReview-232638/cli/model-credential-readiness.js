import { ModelCredentialService } from '../application/model-credentials/model-credential-service.js';
import { requiredModelCredentialProviders } from '../application/model-resolution/required-model-credential-providers.js';
import { verifyModelProviderCredentialLive } from './model-credential-verify.js';
export async function inspectModelCredentialReadiness(runtimeHome, settings, options = {}) {
    if (settings.credentialBroker.mode !== 'gantry') {
        return {
            id: 'model-access-credentials',
            title: 'Model Access Credentials',
            status: 'warn',
            message: 'Model Access is disabled; no provider credentials can be checked.',
            nextAction: 'Set model_access.enabled to true and add model credentials before running agents.',
            action: {
                type: 'connect_provider',
                label: 'Set model_access.enabled to true and add model credentials before running agents.',
            },
        };
    }
    const requiredProviders = requiredModelCredentialProviders(settings);
    if (requiredProviders.length === 0) {
        return {
            id: 'model-access-credentials',
            title: 'Model Access Credentials',
            status: 'pass',
            message: 'No executable model providers are selected.',
        };
    }
    process.env.GANTRY_HOME = runtimeHome;
    let storage;
    try {
        const { createStorageRuntime } = await import('../adapters/storage/postgres/factory.js');
        storage = createStorageRuntime();
        const service = new ModelCredentialService(storage.repositories.modelCredentials);
        const rows = await service.list({ appId: 'default' });
        const healthByProvider = new Map(rows.map((row) => [row.providerId, row.health]));
        // Re-derive with the stored credential set so family aliases require the
        // member the runtime would actually select.
        const configuredProviderIds = new Set(rows.filter((row) => row.health === 'ready').map((row) => row.providerId));
        const refinedRequiredProviders = requiredModelCredentialProviders(settings, { configuredProviderIds });
        const missing = refinedRequiredProviders.filter((providerId) => healthByProvider.get(providerId) !== 'ready');
        if (missing.length > 0) {
            const missingCredentialAction = {
                type: 'connect_provider',
                label: `Run ${missing
                    .map((providerId) => `\`gantry credentials model set ${providerId}\``)
                    .join(' and ')}.`,
            };
            return {
                id: 'model-access-credentials',
                title: 'Model Access Credentials',
                status: 'fail',
                message: `Missing active model credentials for selected defaults: ${missing.join(', ')}.`,
                nextAction: missingCredentialAction.label,
                action: missingCredentialAction,
            };
        }
        if (options.live) {
            const skipLiveProviderIds = new Set(options.skipLiveProviderIds ?? []);
            const liveResults = await Promise.all(refinedRequiredProviders
                .filter((providerId) => !skipLiveProviderIds.has(providerId))
                .map(async (providerId) => {
                const credential = await service.getActiveCredential({
                    appId: 'default',
                    providerId: providerId,
                });
                if (!credential) {
                    return {
                        providerId,
                        result: {
                            ok: false,
                            message: `No active ${providerId} model credential was found.`,
                        },
                    };
                }
                return {
                    providerId,
                    result: await verifyModelProviderCredentialLive({
                        providerId,
                        authMode: credential.authMode,
                        payload: credential.payload,
                    }),
                };
            }));
            const failed = liveResults.find((item) => 'ok' in item.result && !item.result.ok);
            if (failed && 'ok' in failed.result && !failed.result.ok) {
                const actionLabel = `gantry credentials model set ${failed.providerId}`;
                return {
                    id: 'model-access-credentials',
                    title: 'Model Access Credentials',
                    status: 'fail',
                    message: `${failed.providerId} live credential check failed: ${failed.result.message}`,
                    nextAction: actionLabel,
                    action: {
                        type: 'connect_provider',
                        label: actionLabel,
                    },
                };
            }
        }
        return {
            id: 'model-access-credentials',
            title: 'Model Access Credentials',
            status: 'pass',
            message: `Active model credentials found for selected defaults: ${refinedRequiredProviders.join(', ')}.`,
        };
    }
    catch (err) {
        return {
            id: 'model-access-credentials',
            title: 'Model Access Credentials',
            status: 'fail',
            message: `Could not inspect model credentials: ${err instanceof Error ? err.message : String(err)}`,
            nextAction: 'Confirm Postgres is reachable, migrations have run, and SECRET_ENCRYPTION_KEY or SECRET_ENCRYPTION_KEYRING_JSON is configured.',
            action: {
                type: 'run_verification',
                label: 'Confirm Postgres is reachable, migrations have run, and SECRET_ENCRYPTION_KEY or SECRET_ENCRYPTION_KEYRING_JSON is configured.',
            },
        };
    }
    finally {
        await storage?.runtimeEventNotifier.close().catch(() => undefined);
        await storage?.service.close().catch(() => undefined);
    }
}
