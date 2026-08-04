import { type EnqueueToolchainBakeResult } from './toolchain-bake-enqueue.js';
import { ToolchainBakeQueue } from './toolchain-bake-queue.js';
import type { ToolchainBakeOutcomeNotice } from './toolchain-bake-executor.js';
export interface ToolchainBakeBootstrapDeps {
    outcomeNotice: ToolchainBakeOutcomeNotice;
}
/**
 * Start the toolchain bake queue plus its reaper. Only meaningful in fleet
 * mode — the caller (and this function) no-op in workstation mode so bakes
 * never run there. Wire this from the runtime bootstrap after storage is
 * initialized. The reaper recovers rows stranded at `queued`/`baking` by a
 * worker hard-death, a rolling-deploy drain, or a dead-lettered delivery —
 * without it an approved dependency could silently never bake.
 */
export declare function startToolchainBakeSubsystem(deps: ToolchainBakeBootstrapDeps): Promise<ToolchainBakeQueue | null>;
export declare function stopToolchainBakeSubsystem(): Promise<void>;
/**
 * Enqueue a bake for an approved npm dependency request when in fleet mode.
 * Returns null in workstation mode (the caller keeps the existing local-install
 * behavior). Throws on a non-npm/system-package manifest with the ADR-2 error.
 */
export declare function maybeEnqueueApprovedDependencyBake(input: {
    appId: string;
    packages: string[];
    requestedByAgentId?: string | null;
    approvedByConversationId?: string | null;
    approvedAt?: string | null;
}): Promise<EnqueueToolchainBakeResult | null>;
