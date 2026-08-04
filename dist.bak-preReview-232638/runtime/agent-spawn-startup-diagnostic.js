import { normalizeRuntimeEventConversationId, normalizeRuntimeEventThreadId, } from '../domain/events/runtime-event-conversation.js';
import { RUNTIME_EVENT_TYPES, } from '../domain/events/runtime-event-types.js';
export function countJsonStringArray(value) {
    if (typeof value !== 'string')
        return 0;
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed))
            return 0;
        return parsed.filter((item) => typeof item === 'string')
            .length;
    }
    catch {
        return 0;
    }
}
export function buildRunnerHostStartupDiagnosticEvent(input) {
    const conversationId = normalizeRuntimeEventConversationId(input.conversationId);
    const threadId = normalizeRuntimeEventThreadId({
        conversationId,
        threadId: input.threadId,
    });
    return {
        appId: input.appId,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.jobId ? { jobId: input.jobId } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(threadId ? { threadId } : {}),
        eventType: RUNTIME_EVENT_TYPES.RUN_STARTUP_DIAGNOSTIC,
        actor: 'runtime',
        responseMode: 'none',
        payload: {
            provider: 'host',
            diagnostic: 'host_startup_projection',
            agentEngine: input.agentEngine,
            executionProviderId: input.executionProviderId,
            hostPhases: input.hostPhases,
            toolPolicyRuleCount: input.toolPolicyRuleCount,
            gantryMcpToolCount: input.gantryMcpToolCount,
            attachedMcpSourceCount: input.attachedMcpSourceCount,
            projectedMcpSourceCount: input.projectedMcpSourceCount,
            selectedMcpServerCount: input.selectedMcpServerCount,
            materializedMcpServerCount: input.materializedMcpServerCount,
            runnerVisibleMcpServerCount: input.runnerVisibleMcpServerCount,
            reviewedMcpToolCount: input.reviewedMcpToolCount,
            mcpConfigProjected: input.mcpConfigProjected,
            mcpTransportCounts: input.mcpTransportCounts,
            selectedSkillSourceCount: input.selectedSkillSourceCount,
            selectedSkillDisplayCount: input.selectedSkillDisplayCount,
            selectedSkillSecretEnvCount: input.selectedSkillSecretEnvCount,
            semanticCapabilityCount: input.semanticCapabilityCount,
            runtimeAccessCount: input.runtimeAccessCount,
            browserIpcEnabled: input.browserIpcEnabled,
            memoryIpcActionCount: input.memoryIpcActionCount,
            deepAgentCheckpointerConfigured: input.deepAgentCheckpointerConfigured,
            sandbox: input.sandbox,
            egress: input.egress,
            credentials: input.credentials,
            prompt: input.prompt,
        },
    };
}
export async function publishRunnerHostStartupDiagnosticFromSpawn(input) {
    if (!input.publishRuntimeEvent)
        return;
    const snapshot = input.snapshot;
    const diagnostic = {
        appId: input.runnerAppId,
        ...(input.agentInput.agentId ? { agentId: input.agentInput.agentId } : {}),
        ...(input.agentInput.runId ? { runId: input.agentInput.runId } : {}),
        ...(input.agentInput.jobId ? { jobId: input.agentInput.jobId } : {}),
        conversationId: input.agentInput.chatJid,
        ...(input.agentInput.threadId
            ? { threadId: input.agentInput.threadId }
            : {}),
        agentEngine: input.agentEngine,
        executionProviderId: input.executionProviderId,
        hostPhases: input.hostPhases,
        toolPolicyRuleCount: snapshot.trustedToolPolicyRules?.length ?? 0,
        gantryMcpToolCount: countJsonStringArray(snapshot.preparedEnv.GANTRY_MCP_TOOL_NAMES_JSON),
        attachedMcpSourceCount: snapshot.attachedMcpSourceIds.length,
        projectedMcpSourceCount: snapshot.projectedMcpSourceIds.length,
        selectedMcpServerCount: snapshot.selectedMcpServerNames.length,
        materializedMcpServerCount: snapshot.allMcpCapabilities.length,
        runnerVisibleMcpServerCount: snapshot.runnerVisibleMcpServerNames.length,
        reviewedMcpToolCount: snapshot.reviewedMcpToolNames.length,
        mcpConfigProjected: snapshot.mcpConfigPath !== undefined,
        mcpTransportCounts: mcpTransportCounts(snapshot.allMcpCapabilities),
        selectedSkillSourceCount: input.agentInput.attachedSkillSourceIds?.length ?? 0,
        selectedSkillDisplayCount: input.agentInput.selectedSkillDisplays?.length ?? 0,
        selectedSkillSecretEnvCount: Object.keys(snapshot.selectedSkillEnv.env)
            .length,
        semanticCapabilityCount: snapshot.runnerInput.semanticCapabilities?.length ?? 0,
        runtimeAccessCount: snapshot.effectiveRuntimeAccess.length,
        browserIpcEnabled: snapshot.browserIpcEnabled,
        memoryIpcActionCount: snapshot.memoryIpcAllowedActions.length,
        deepAgentCheckpointerConfigured: snapshot.runnerInput.deepAgentCheckpointer !== undefined,
        sandbox: {
            provider: snapshot.runnerSandboxProviderId,
            enforcing: snapshot.runnerSandboxEnforcing,
            allowedNetworkHostCount: snapshot.finalAllowedNetworkHosts.length,
            protectedReadPathCount: snapshot.sandboxProtectedReadPaths.length,
            protectedWritePathCount: snapshot.sandboxProtectedWritePaths.length,
            localCliCredentialPathCount: snapshot.localCliCredentialPaths.length,
            warmTemplateAvailable: snapshot.sandboxWarmTemplate.available,
            warmTemplateCacheHit: snapshot.sandboxWarmTemplate.cacheHit,
        },
        egress: {
            proxyConfigured: snapshot.egressProxyConfigured,
            upstreamProxyConfigured: snapshot.upstreamProxyConfigured,
        },
        credentials: {
            brokerApplied: snapshot.hostCredentials.brokerApplied,
            credentialProviderCount: Object.keys(snapshot.hostCredentials.credentialProviders).length,
            modelCredentialEnvKeyCount: Object.keys(snapshot.runnerInput.modelCredentialEnv ?? {}).length,
        },
        prompt: {
            compiledSystemPromptChars: snapshot.compiledSystemPrompt.length,
        },
    };
    try {
        await input.publishRuntimeEvent(buildRunnerHostStartupDiagnosticEvent(diagnostic));
    }
    catch (err) {
        input.logger.warn({
            err,
            appId: diagnostic.appId,
            agentId: diagnostic.agentId,
            runId: diagnostic.runId,
        }, 'Runner host startup diagnostic persistence failed');
    }
}
function mcpTransportCounts(capabilities) {
    return capabilities.reduce((counts, capability) => {
        const type = capability.config.type ?? 'stdio';
        counts[type] += 1;
        return counts;
    }, { stdio: 0, http: 0, sse: 0 });
}
