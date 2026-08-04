import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
export function sandboxBlockedEvents(input) {
    const { spec } = input;
    const provider = spec.options?.runnerSandboxProvider;
    return [
        {
            appId: spec.sandbox.principal.appId,
            agentId: spec.sandbox.principal.agentId,
            runId: spec.sandbox.principal.runId,
            jobId: spec.sandbox.principal.jobId,
            conversationId: spec.sandbox.principal.conversationId,
            threadId: spec.sandbox.principal.threadId,
            eventType: RUNTIME_EVENT_TYPES.SANDBOX_BLOCKED,
            actor: 'runner',
            responseMode: 'none',
            payload: {
                provider: provider?.id ?? 'direct',
                enforcing: provider?.enforcing === true,
                profileId: spec.sandbox.sandboxProfile.id,
                networkMode: spec.sandbox.sandboxProfile.network,
                filesystemMode: spec.sandbox.sandboxProfile.filesystem,
                allowedNetworkHostCount: spec.sandbox.allowedNetworkHosts.length,
                runtimeReadPathCount: spec.sandbox.runtimeReadPaths.length,
                runtimeWritePathCount: spec.sandbox.runtimeWritePaths.length,
                protectedReadPathCount: spec.sandbox.protectedReadPaths.length,
                protectedWritePathCount: spec.sandbox.protectedWritePaths.length,
                resourceLimits: spec.sandbox.resourceLimits,
                message: input.sanitize(input.message, 500),
            },
        },
    ];
}
