import type { SettingsRevisionRepository } from '../../domain/ports/fleet-capability-state.js';
import type { RuntimeConversationRouteRepository } from '../../domain/repositories/ops-repo.js';
import type { SettingsDesiredStateRepositories } from './desired-state-service.js';
export type AgentToolRuleSettingsRepositories = SettingsDesiredStateRepositories & {
    settingsRevisions?: SettingsRevisionRepository;
};
export declare function createAgentToolRuleSettingsMirror(input: {
    opsRepository: RuntimeConversationRouteRepository;
    repositories?: AgentToolRuleSettingsRepositories;
    reloadRuntimeState: () => Promise<void>;
}): (sourceAgentFolder: string, rules: string[], options?: {
    appId?: string;
    mode?: 'add' | 'remove';
}) => Promise<void> | void;
