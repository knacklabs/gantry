import type { ConversationRoute } from '../domain/types.js';
import { resolveRoutelessAgentFolder } from './group-helpers.js';
/**
 * Remove an agent that has no conversation routes left.
 *
 * `resolveGroupSelector` matches only against existing route keys, so once an
 * agent's last route is gone it cannot be named by any agent subcommand -- yet
 * its definition survives in the settings-revision authority and is re-imported
 * on every boot. This is the entry point that makes such an agent removable.
 *
 * Returns an exit code when the selector named a route-less agent, or null when
 * it did not, so the caller can fall through to its normal not-found handling.
 */
export declare function removeRoutelessAgent(input: {
    runtimeHome: string;
    settings: Parameters<typeof resolveRoutelessAgentFolder>[0]['settings'];
    groups: Record<string, ConversationRoute>;
    selector: string;
    assumeYes: boolean;
}): Promise<number | null>;
