import { preloadCallableAgentManifest } from '../application/core-tools/callable-agent-tools.js';
import { nowMs } from '../shared/time/datetime.js';
import { prepareRunnerWorkspace } from './agent-spawn-helpers.js';
import { createRunnerHostStartupTiming } from './agent-spawn-startup-timing.js';
export { registerWorkerPermissionRunRestriction } from './agent-spawn-permission-run-restriction.js';
export async function prepareAgentSpawn(input) {
    const { agentRuntime } = input;
    if (agentRuntime === 'inline') {
        const { runInlineAgent } = await import('./agent-inline.js');
        return {
            kind: 'inline',
            output: await runInlineAgent(input.group, input.agentInput, input.onProcess, input.onOutput, input.options),
        };
    }
    const startTime = nowMs();
    const hostStartup = createRunnerHostStartupTiming({ nowMs });
    const { groupDir, processName } = hostStartup.measure('workspacePrepMs', () => prepareRunnerWorkspace({
        folder: input.group.folder,
        nowMs,
        warn: input.warn,
    }));
    return {
        kind: 'worker',
        agentRuntime,
        startTime,
        hostStartup,
        groupDir,
        processName,
    };
}
export async function prepareWorkerAuthorityProjection(input) {
    const accessPreset = input.accessPreset === 'locked' ? 'locked' : 'full';
    const hideAuthorityTools = accessPreset === 'locked' ||
        input.agentInput.hideAuthorityTools === true ||
        process.env.GANTRY_NO_PERMISSION_TOOLS === '1';
    const callableAgentManifest = await preloadCallableAgentManifest({
        run: input.agentInput,
        delegates: input.delegates,
        callerFolder: input.workspaceFolder,
        conversationBoundAgentIds: input.options?.asyncTaskRepositoryAvailable === true &&
            !hideAuthorityTools &&
            input.agentInput.parentTaskId == null &&
            input.agentInput.toolPolicyRules?.includes('AgentDelegation') &&
            input.delegates.length > 0
            ? input.getConversationBoundAgentIds()
            : new Set(),
        personasByAgentId: input.personasByAgentId,
        toolsAvailable: input.options?.asyncTaskRepositoryAvailable === true &&
            !hideAuthorityTools,
        getRepository: input.getAgentRepository,
        warn: input.warn,
    });
    return { accessPreset, hideAuthorityTools, callableAgentManifest };
}
