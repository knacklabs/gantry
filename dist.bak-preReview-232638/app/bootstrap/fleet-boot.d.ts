import type { Pool } from 'pg';
import type { AppId } from '../../domain/app/app.js';
import type { ToolchainBakeOutcomeNotice } from '../../jobs/toolchain-bake-executor.js';
import { SettingsRevisionListener } from '../../runtime/settings-revision-listener.js';
import type { RuntimeApp } from './runtime-app.js';
import type { ControlAgentSettingsPort, ControlSettingsImportPort, EffectiveControlRuntimeSettings } from '../../application/control-plane/control-plane-storage-model.js';
export declare function createControlAgentSettingsPort(): ControlAgentSettingsPort;
export declare function createControlSettingsImportPort(): ControlSettingsImportPort;
export interface FleetSettingsResult {
    loaded: boolean;
    revision: number | null;
}
/**
 * Fetch the latest settings revision and render it to the runtime settings home
 * so the existing `loadRuntimeSettings` path reads the fleet desired state. When
 * no revision has been seeded yet, mark settings NOT loaded (so `/readyz` goes
 * red via the existing settings check) and log the exact seed command. This runs
 * before runtime services need settings (ADR-3 fleet boot).
 */
export declare function prepareFleetSettings(input: {
    appId: AppId;
    runtimeHome: string;
    app: RuntimeApp;
}): Promise<FleetSettingsResult>;
export interface FleetSubsystems {
    stop: () => Promise<void>;
    settingsRevisionListener: SettingsRevisionListener;
}
/**
 * Start the fleet-only worker subsystems: the toolchain bake queue, the worker
 * capability reconciler, and the settings revision listener. Each owns stoppable
 * timers/LISTEN clients; {@link FleetSubsystems.stop} tears them all down for
 * the drain sequence. Workstation never calls this.
 *
 * When `settingsLoaded` is false (first fleet boot with no seeded revision) the
 * bake queue and capability reconciler are HELD — only the revision listener
 * starts, because it is the thing that eventually loads settings. The first
 * applied revision starts the held subsystems and invokes `onSettingsReady`
 * (app boot uses it to release the held scheduler start).
 */
export declare function startFleetSubsystems(input: {
    app: RuntimeApp;
    appId: AppId;
    runtimeHome: string;
    pool: Pool;
    /** Best-effort delivery for bake outcome notices to the approval conversation. */
    sendMessage: (conversationJid: string, text: string) => Promise<void>;
    /**
     * Whether this process role runs the toolchain bake queue + reaper (all,
     * job-worker). Defaults true so existing fleet callers are unchanged.
     */
    bakeExecution?: boolean;
    /**
     * Whether this process role materializes/advertises capabilities via the
     * worker capability reconciler (all, live-worker, job-worker). Defaults true.
     */
    capabilityReconciliation?: boolean;
    /** Whether a settings revision was applied at boot (prepareFleetSettings). */
    settingsLoaded: boolean;
    /** Released once, with the held subsystems, on the first applied revision. */
    onSettingsReady?: (settings: EffectiveControlRuntimeSettings) => Promise<void> | void;
}): Promise<FleetSubsystems>;
/**
 * One concise best-effort outcome message per terminal bake state to the
 * approval conversation that requested the dependency. Delivery failures are
 * logged, never thrown — a notice must not fail (or retry) the bake.
 * Exported for unit tests.
 */
export declare function buildBakeOutcomeNotice(sendMessage: (conversationJid: string, text: string) => Promise<void>): ToolchainBakeOutcomeNotice;
