import type { AgentPersona } from '../shared/agent-persona.js';
import { effectiveYoloModeSettings } from '../shared/yolo-mode-policy.js';
import type { RunnerAgentInput } from './agent-spawn-helpers.js';
import type { AgentInput } from './agent-spawn-types.js';
export declare function agentPersonasById(agents: Record<string, {
    persona?: AgentPersona;
}>): Record<string, AgentPersona | undefined>;
export declare function projectSpawnRunnerInput(input: {
    agentInput: AgentInput;
    workspaceFolder: string;
    callableAgentManifest: RunnerAgentInput['callableAgentManifest'];
    hideAuthorityTools: boolean;
    compiledSystemPrompt: string;
    permissions: {
        yoloMode: Parameters<typeof effectiveYoloModeSettings>[0];
        egress: {
            denylist: string[];
        };
    };
}): {
    runnerInput: RunnerAgentInput;
    browserIpcEnabled: boolean;
    trustedToolPolicyRules: AgentInput['toolPolicyRules'];
};
