import type { ConversationRoute } from '../domain/types.js';
import type { FileArtifactStore } from '../domain/ports/file-artifact-store.js';
import { loadRuntimeSettings } from '../config/settings/runtime-settings.js';
import { RuntimeGroupDb } from './runtime-group-db.js';
export { formatAgentHarnessLine } from './group-engine.js';
export declare function usage(): string;
export declare function findConversationIdForAgent(settings: ReturnType<typeof loadRuntimeSettings>, agentId: string, providerId: string): string | null;
export declare function conversationIdsForProvider(settings: ReturnType<typeof loadRuntimeSettings>, providerId: string): string[];
export declare function pruneAgentSenderPolicyOverride(runtimeHome: string, jid: string, folder: string): Promise<{
    pruned: boolean;
    error?: string;
}>;
/**
 * Remove an agent's definition from desired state once its LAST route is gone.
 *
 * Route deletion alone is not durable: desired-state reconciliation re-imports
 * every `settings.agents` entry at startup and on each settings change, so an
 * agent whose definition survives is recreated -- along with its routes and
 * system jobs -- on the next reload. Callers must invoke this after removing a
 * route so removal actually persists.
 *
 * No-ops while the agent still owns other routes: removing one route of a
 * multi-route agent must not delete the agent.
 */
export declare function pruneDesiredStateAgent(input: {
    runtimeHome: string;
    folder: string;
    remainingRoutes: number;
}): Promise<{
    pruned: boolean;
    providerAccountsPruned: number;
    reconciled?: boolean;
    keptForDelegates?: string[];
    keptAsDefault?: boolean;
    error?: string;
}>;
/**
 * Best-effort cleanup of a removed agent's projected `gantry.agents` row.
 *
 * Desired-state removal (`pruneDesiredStateAgent`) is the durable source of
 * truth, but the projected row is a mirror that authoritative reconcile only
 * disables when `desired_state.authoritative` is true -- which live config
 * leaves false. So an explicit CLI removal must disable the mirror itself, the
 * same primitive reconcile uses (`desired-state-service.ts` `disableAgent`).
 *
 * Never throws: the row is a mirror, not the authority, so a storage failure
 * here must not fail a removal that already persisted. On failure it warns and
 * reports the error to the caller (which still exits 0). `disableAgent` returns
 * null when no row exists (already gone).
 *
 * ponytail: not revision-coupled. A concurrent re-add of the same folder
 * (remover persists a drop; adder persists a newer revision restoring it) can
 * race this disable and leave a declared agent's row disabled. That state is
 * transient and self-healing -- the next desired-state reconcile re-imports
 * every declared agent and upserts status:'active' (desired-state-service.ts
 * :181). Closing the window fully needs a revision-coupled compare-and-set on
 * the row (follow-up #290), out of scope for this projection-cleanup fix.
 */
export declare function disableRemovedAgentProjection(folder: string): Promise<{
    disabled: boolean;
    error?: string;
}>;
/**
 * Resolve a selector that names an agent with NO conversation routes.
 *
 * `resolveGroupSelector` matches only against existing route keys, so an agent
 * whose last route is already gone is unaddressable by every agent subcommand
 * -- while its definition lives on in the settings-revision authority and is
 * re-imported on each boot. Fall back to the desired-state agent set so such an
 * agent can still be named (and therefore removed).
 *
 * Returns null when the selector matches nothing, or when the agent still owns
 * routes (that case belongs to the normal route-scoped path).
 */
export declare function resolveRoutelessAgentFolder(input: {
    settings: ReturnType<typeof loadRuntimeSettings>;
    groups: Record<string, ConversationRoute>;
    selector: string;
}): string | null;
export declare function syncConfiguredConversationBinding(input: {
    runtimeHome: string;
    agentId: string;
    agentName: string;
    agentFolder: string;
    jid: string;
    displayName: string;
    trigger: string;
    requiresTrigger: boolean;
}): Promise<void>;
export declare function seedTelegramControlApproverForAgent(input: {
    runtimeHome: string;
    db: RuntimeGroupDb;
    chatJid: string;
    agentFolder: string;
}): Promise<string | undefined>;
export declare function normalizeGroupAddSelector(raw: string): string | null;
export declare function loadDatabase(runtimeHome: string): Promise<RuntimeGroupDb>;
export declare function listGroupsWithJid(groups: Record<string, ConversationRoute>): Array<{
    jid: string;
    group: ConversationRoute;
}>;
export declare function resolveGroupSelector(groups: Record<string, ConversationRoute>, rawSelector: string): {
    found: {
        jid: string;
        group: ConversationRoute;
    } | null;
    error?: string;
};
export declare function isInteractiveTerminal(): boolean;
export declare function allocateGroupFolder(options: {
    runtimeHome: string;
    groups: Record<string, ConversationRoute>;
    preferredFolder?: string;
    seed: string;
}): string;
export declare function ensureGroupFiles(runtimeHome: string, folder: string, agentName: string, fileArtifactStore: FileArtifactStore): Promise<void>;
