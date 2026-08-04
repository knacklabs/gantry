import type { ToolchainBakeQueuePort } from './toolchain-bake-enqueue.js';
import { type ToolchainBakeExecutorDeps } from './toolchain-bake-executor.js';
export interface ToolchainBakeSenderOptions {
    connectionString: string;
    schema?: string;
    applicationName?: string;
}
/**
 * Send-only toolchain bake enqueue port. Opens pg-boss, sends the bake job with
 * the manifest-hash singleton key (matching {@link ToolchainBakeQueue}), and
 * closes — it registers NO worker. Used by `gantry artifacts quarantine rebake`,
 * which only needs to re-queue a bake for a running fleet worker to claim.
 */
export declare class ToolchainBakeSender implements ToolchainBakeQueuePort {
    private readonly options;
    private boss;
    constructor(options: ToolchainBakeSenderOptions);
    start(): Promise<void>;
    stop(): Promise<void>;
    enqueueBake(input: {
        dependencyId: string;
        manifestHash: string;
    }): Promise<void>;
}
export interface ToolchainBakeQueueOptions {
    connectionString: string;
    schema?: string;
    applicationName?: string;
    logError?: (context: Record<string, unknown>, message: string) => void;
    logInfo?: (context: Record<string, unknown>, message: string) => void;
}
/**
 * pg-boss-backed toolchain bake queue. A bake is a job like any other: it is
 * enqueued with a singleton key on the manifest hash (so a repeated enqueue for
 * the same manifest collapses to one in-flight job), claimed at-most-once by a
 * registered worker, and its status writes are fenced by the runtime_dependency
 * row status CAS inside {@link executeToolchainBake}. Started ONLY in fleet
 * mode; workstation never bakes (local installs are unchanged).
 *
 * Stoppable: {@link stop} grace-stops pg-boss so tests and drains exit cleanly.
 */
export declare class ToolchainBakeQueue implements ToolchainBakeQueuePort {
    private readonly executorDeps;
    private readonly options;
    private boss;
    constructor(executorDeps: ToolchainBakeExecutorDeps, options: ToolchainBakeQueueOptions);
    start(): Promise<void>;
    /**
     * Drain decision (deliberate): stop does NOT await an in-flight bake beyond
     * pg-boss's short grace window. The default drain deadline (120s) is shorter
     * than the install timeout (5 min), so waiting could never guarantee
     * completion — a drain mid-install strands the row at `baking` and the
     * `ToolchainBakeReaper` on a live worker CAS-resets it to `queued` and
     * re-enqueues within the reap threshold. Accepting the strand keeps shutdown
     * fast and bounded instead of holding the deploy hostage to npm.
     */
    stop(): Promise<void>;
    enqueueBake(input: {
        dependencyId: string;
        manifestHash: string;
    }): Promise<void>;
    private processJobs;
}
