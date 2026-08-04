import type { Pool } from 'pg';
import type { RuntimeDependency } from '../domain/ports/fleet-capability-state.js';
import type { ToolchainBakeNotifier } from './toolchain-bake-executor.js';
/**
 * pg_notify channel the bake publishes to and worker reconcilers LISTEN on.
 * Carried as a plain literal so publisher and listener cannot drift.
 */
export declare const TOOLCHAIN_MANIFEST_CHANNEL = "gantry_runtime_dependencies";
export interface ToolchainManifestWakeup {
    appId: string;
    manifestHash: string;
    status: RuntimeDependency['status'];
}
/**
 * Pool-backed manifest notifier. A failed NOTIFY is logged, not thrown: the
 * reconciler's interval poll fallback recovers a dropped wakeup, so the bake
 * lifecycle is not blocked on notification delivery.
 */
export declare class PostgresToolchainManifestNotifier implements ToolchainBakeNotifier {
    private readonly pool;
    private readonly logWarn?;
    constructor(pool: Pool, logWarn?: ((context: Record<string, unknown>, message: string) => void) | undefined);
    notifyManifestChanged(input: ToolchainManifestWakeup): Promise<void>;
}
