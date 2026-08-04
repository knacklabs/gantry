import { AUTO_AGENT_HARNESS, } from '../shared/agent-engine.js';
export function selectedAgentHarnessForFolder(settings, folder) {
    return (settings.agents[folder]?.agentHarness ??
        settings.agent.agentHarness ??
        AUTO_AGENT_HARNESS);
}
export function formatAgentHarnessCell(settings, folder) {
    return selectedAgentHarnessForFolder(settings, folder);
}
export function formatAgentHarnessLine(settings, folder) {
    return `Agent harness: ${formatAgentHarnessCell(settings, folder)}`;
}
