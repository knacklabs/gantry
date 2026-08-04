/**
 * pg_notify channel the bake publishes to and worker reconcilers LISTEN on.
 * Carried as a plain literal so publisher and listener cannot drift.
 */
export const TOOLCHAIN_MANIFEST_CHANNEL = 'gantry_runtime_dependencies';
/**
 * Pool-backed manifest notifier. A failed NOTIFY is logged, not thrown: the
 * reconciler's interval poll fallback recovers a dropped wakeup, so the bake
 * lifecycle is not blocked on notification delivery.
 */
export class PostgresToolchainManifestNotifier {
    pool;
    logWarn;
    constructor(pool, logWarn) {
        this.pool = pool;
        this.logWarn = logWarn;
    }
    async notifyManifestChanged(input) {
        const payload = JSON.stringify({
            appId: input.appId,
            manifestHash: input.manifestHash,
            status: input.status,
        });
        try {
            await this.pool.query('SELECT pg_notify($1, $2)', [
                TOOLCHAIN_MANIFEST_CHANNEL,
                payload,
            ]);
        }
        catch (err) {
            this.logWarn?.({ err, appId: input.appId, manifestHash: input.manifestHash }, 'Failed to publish toolchain manifest wakeup; reconcilers recover by poll');
        }
    }
}
