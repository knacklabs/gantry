import * as p from '@clack/prompts';
import { disableRemovedAgentProjection, isInteractiveTerminal, pruneDesiredStateAgent, resolveRoutelessAgentFolder, } from './group-helpers.js';
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
export async function removeRoutelessAgent(input) {
    const folder = resolveRoutelessAgentFolder({
        settings: input.settings,
        groups: input.groups,
        selector: input.selector,
    });
    if (!folder)
        return null;
    if (!input.assumeYes) {
        if (!isInteractiveTerminal()) {
            p.log.error('Refusing destructive removal in non-interactive mode without --yes.');
            return 1;
        }
        const decision = await p.select({
            message: `Remove agent ${folder} (no conversation routes) from desired state?`,
            options: [
                { label: 'Yes, remove it', value: 'yes' },
                { label: 'No, cancel', value: 'no' },
            ],
        });
        if (p.isCancel(decision) || decision !== 'yes') {
            p.log.warn('Agent removal cancelled. No changes were made.');
            return 0;
        }
    }
    const pruned = await pruneDesiredStateAgent({
        runtimeHome: input.runtimeHome,
        folder,
        remainingRoutes: 0,
    });
    if (pruned.error) {
        p.log.error(`Removal did not persist for ${folder}: ${pruned.error}. It will be recreated on the next reload.`);
        return 1;
    }
    if (pruned.keptAsDefault) {
        p.log.error(`Agent ${folder} is the default agent (main_agent) and cannot be removed; it underpins runtime startup. Use \`gantry agent name\` to rename it instead.`);
        return 1;
    }
    if (pruned.keptForDelegates?.length) {
        p.log.warn(`Agent ${folder} is retained: still referenced as a delegate by ${pruned.keptForDelegates.join(', ')}.`);
        p.log.info('Next action: remove those delegate references first if you want the agent fully deleted.');
        // Nothing was removed here -- unlike the route-scoped path there is no
        // route deletion to count as partial success -- so automation must not be
        // told this succeeded.
        return 1;
    }
    if (!pruned.pruned) {
        p.log.error(`Agent ${folder} was not removed from desired state.`);
        return 1;
    }
    // Deliberately no filesystem cleanup: Postgres is the source of truth, and
    // `agent remove` stopped touching agent folders when --delete-folder was
    // removed. The route-scoped path does not delete folders either, so this
    // path must not either -- the only fs.rmSync left in this command family is
    // runAdd's rollback of a folder it had just created.
    // Best-effort: only when the revision durably persisted (reconciled) do we
    // disable the projected agents row so it stops reading active. The desired-
    // state prune above is the durable removal; the helper warns (and this path
    // still succeeds) if the mirror write fails.
    if (pruned.reconciled)
        await disableRemovedAgentProjection(folder);
    const accounts = pruned.providerAccountsPruned;
    p.log.success(`Removed agent ${folder} from desired state${accounts > 0 ? ` (and ${accounts} orphaned provider account(s))` : ''}.`);
    return 0;
}
