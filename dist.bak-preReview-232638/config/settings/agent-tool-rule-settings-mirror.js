import { GANTRY_HOME } from '../index.js';
import { mirrorAgentToolRulesToRuntimeSettings } from './runtime-settings.js';
import { addAgentToolRulesToSyncedRuntimeSettings, removeAgentToolRulesFromSyncedRuntimeSettings, } from './restart-sync.js';
export function createAgentToolRuleSettingsMirror(input) {
    return (sourceAgentFolder, rules, options) => {
        if (input.repositories) {
            const shared = {
                runtimeHome: GANTRY_HOME,
                agentFolder: sourceAgentFolder,
                rules,
                ops: input.opsRepository,
                repositories: input.repositories,
                appId: options?.appId,
                reloadRuntimeState: input.reloadRuntimeState,
                settingsRevisions: input.repositories.settingsRevisions,
            };
            return options?.mode === 'remove'
                ? removeAgentToolRulesFromSyncedRuntimeSettings(shared)
                : addAgentToolRulesToSyncedRuntimeSettings(shared);
        }
        return mirrorAgentToolRulesToRuntimeSettings({
            runtimeHome: GANTRY_HOME,
            agentFolder: sourceAgentFolder,
            rules,
            mode: options?.mode,
        });
    };
}
