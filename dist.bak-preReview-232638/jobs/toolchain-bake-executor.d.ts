import type { RuntimeDependency, RuntimeDependencyRepository } from '../domain/ports/fleet-capability-state.js';
import type { ToolchainArtifactStore } from '../domain/ports/toolchain-artifact-store.js';
import type { ToolchainCommandRunner } from './toolchain-bake-runner.js';
export interface ToolchainBakeNotifier {
    /** pg_notify the manifest channel so worker reconcilers wake on completion. */
    notifyManifestChanged(input: {
        appId: string;
        manifestHash: string;
        status: RuntimeDependency['status'];
    }): Promise<void>;
}
/**
 * Outcome notices to the approval conversation that requested the dependency.
 * Both are one concise message, best-effort at the call site (delivery reuses
 * the channel machinery; the executor only formats and triggers them) — a
 * notice failure never fails the bake.
 */
export interface ToolchainBakeOutcomeNotice {
    /** Bake uploaded: the toolchain is rolling out to workers. */
    sendSuccessNotice(input: {
        dependency: RuntimeDependency;
    }): Promise<void>;
    /** Bake failed: include the concise reason. */
    sendFailureNotice(input: {
        dependency: RuntimeDependency;
        reason: string;
    }): Promise<void>;
}
export interface ToolchainBakeExecutorDeps {
    runtimeDependencies: RuntimeDependencyRepository;
    toolchainStore: ToolchainArtifactStore;
    commandRunner: ToolchainCommandRunner;
    notifier: ToolchainBakeNotifier;
    outcomeNotice: ToolchainBakeOutcomeNotice;
    registry: string;
    logWarn?: (context: Record<string, unknown>, message: string) => void;
    /** Override the npm binary/argv prefix for tests. Defaults to `npm`. */
    npmCommand?: string;
    installTimeoutMs?: number;
}
export type ToolchainBakeOutcome = {
    result: 'uploaded';
    manifestHash: string;
} | {
    result: 'skipped';
    reason: 'not_claimable';
} | {
    result: 'failed';
    reason: string;
};
export declare const DEFAULT_INSTALL_TIMEOUT_MS: number;
/**
 * Execute a single toolchain bake for a runtime_dependencies row. Lifecycle:
 * claim queued→baking (status CAS = the bake's lease), run lockfile-pinned
 * `npm install --ignore-scripts` in a temp dir against the allowlisted
 * registry, pack node_modules + lockfile + package.json, upload via the
 * artifact store, then transition baking→uploaded with the artifact ref + hash
 * and NOTIFY. Either terminal outcome sends one concise best-effort notice to
 * the approval conversation: success ("baked and rolling out") on uploaded,
 * the failure reason on →failed. Idempotent: a row that is not `queued`
 * (another worker already claimed/completed it) short-circuits.
 *
 * Crash/drain recovery: a hard death (SIGKILL/OOM) or a rolling-deploy drain
 * mid-install strands the row at `baking` — drain deliberately does NOT await
 * the in-flight install (the default drain deadline is shorter than the install
 * timeout, so waiting could not guarantee completion anyway; see
 * `ToolchainBakeQueue.stop`). The `ToolchainBakeReaper` recovers it: rows whose
 * `updated_at` is older than `bakeReapStalenessMs()` (≥ 2× the install timeout
 * plus an upload allowance) are CAS-reset baking→queued and re-enqueued.
 *
 * Double-bake tolerance: a slow-but-alive baker can exceed the reap threshold,
 * lose its row to the reaper, and race a second baker for the same manifest.
 * Both terminal CAS writes here guard on fromStatus 'baking', and a lost CAS is
 * a benign no-op (outcome `skipped`, no NOTIFY, no user notice) — exactly one
 * baker's terminal write lands. The generous reap threshold makes this race
 * rare; if the loser's S3 upload still overwrote the winner's bytes, the worker
 * reconciler's sha256 verify quarantines the mismatch and
 * `gantry artifacts quarantine rebake` re-bakes it.
 */
export declare function executeToolchainBake(deps: ToolchainBakeExecutorDeps, input: {
    dependencyId: string;
}): Promise<ToolchainBakeOutcome>;
