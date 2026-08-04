import { DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE, evaluateDeepAgentsAsyncSubagentSentinel, } from './async-subagent-sentinel.js';
export function evaluateAgentDelegationAsyncBridge(input) {
    if (!input.asyncTaskToolsEnabled) {
        return unavailable('async_task_tools_disabled');
    }
    if (!input.sandboxReady) {
        return unavailable('sandbox_unavailable');
    }
    if (!input.agentDelegationAuthorized) {
        return unavailable('agent_delegation_unauthorized');
    }
    if (!input.transportReady) {
        return unavailable('transport_unavailable');
    }
    const sentinel = evaluateDeepAgentsAsyncSubagentSentinel({
        packageVersion: input.packageVersion,
        deepagentsModule: input.providerModule,
        gantryAgentProtocolTransportReady: true,
    });
    if (!sentinel.ok) {
        return unavailable('provider_async_bridge_unavailable');
    }
    return {
        status: 'ready',
        intent: input.intent,
        packageVersion: sentinel.packageVersion,
        apiCompatible: true,
    };
}
function unavailable(reason) {
    return {
        status: 'unavailable',
        reason,
        message: DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE,
    };
}
