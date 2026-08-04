import type { CoreSendMessageDeps } from '../../application/core-tools/send-message.js';
import { type CallableAgentToolManifestEntry } from '../../application/core-tools/callable-agent-tools.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import type { RuntimeAgentSessionRepository } from '../../domain/repositories/ops-repo.js';
import type { AsyncTaskRepository } from '../../domain/ports/async-tasks.js';
import type { PermissionPromotionRepository } from '../../domain/ports/permission-promotion.js';
import type { AgentRepository, McpServerRepository, ToolCatalogRepository } from '../../domain/ports/repositories.js';
import type { InlineAgentLoopLaneInput } from '../../runtime/agent-inline.js';
import type { RunAgentOptions } from '../../runtime/agent-spawn-types.js';
import { type PermissionClassifierPromptConsultInput } from '../../runtime/permission-classifier.js';
import { createCoreToolRegistry } from '../../runtime/core-tools/registry.js';
import type { YoloModeSettings } from '../../shared/yolo-mode-policy.js';
import type { ChannelWiring } from './channel-wiring-types.js';
import { type InlineConfiguredAgents } from './inline-callable-agent-tools.js';
import { type ThirdPartyMcpToolActivity } from './inline-agent-loop-mcp-activity.js';
import type { InlineCoreToolSupport } from './inline-agent-loop-tool-types.js';
import type { RuntimeApp } from './runtime-app.js';
export declare function createInlineCoreToolsForRun(laneInput: InlineAgentLoopLaneInput, support: InlineCoreToolSupport): Promise<ReturnType<typeof createInlineCoreTools>>;
export declare function createInlineCoreTools(laneInput: InlineAgentLoopLaneInput, support: InlineCoreToolSupport, callableAgentManifest?: readonly CallableAgentToolManifestEntry[]): ReturnType<typeof createCoreToolRegistry> & {
    authorizeThirdPartyMcpTool(name: string, input: unknown, context?: {
        signal?: AbortSignal;
    }): Promise<{
        allowed: boolean;
        reason?: string;
    }>;
    recordThirdPartyMcpToolActivity(input: ThirdPartyMcpToolActivity): Promise<void>;
};
export declare function wireInlineAgentLoopTools(input: {
    app: Pick<RuntimeApp, 'executionAdapter' | 'executionAdapters' | 'runnerSandboxProvider' | 'getCredentialBroker' | 'getConversationRoutes' | 'resolveExecutionProviderId'>;
    channelWiring: ChannelWiring;
    interactionsEnabled: boolean;
    getAgentAccessPreset(folder: string): 'full' | 'locked';
    getPermissionRuntimeSettings(): {
        agents?: InlineConfiguredAgents;
        permissions: {
            autoMode: {
                model?: string;
            };
            yoloMode: YoloModeSettings;
        };
        memory: {
            llm: {
                models: {
                    extractor: string;
                };
            };
        };
    };
    getToolRepository?: () => ToolCatalogRepository | undefined;
    getAgentRepository?: () => AgentRepository | undefined;
    getFileArtifactStore?: CoreSendMessageDeps['getFileArtifactStore'];
    getMcpServerRepository?: () => McpServerRepository | undefined;
    getPermissionPromotionRepository?: () => PermissionPromotionRepository | undefined;
    getAsyncTaskRepository?: () => AsyncTaskRepository | undefined;
    opsRepository?: Pick<RuntimeAgentSessionRepository, 'getAgentTurnContext' | 'createSessionAgentRun' | 'completeSessionAgentRun'>;
    getSkillRepository?: () => RunAgentOptions['skillRepository'];
    getSkillArtifactStore?: () => RunAgentOptions['skillArtifactStore'];
    getCapabilitySecretRepository?: () => RunAgentOptions['capabilitySecretRepository'] | undefined;
    getMcpDnsValidationCache?: () => RunAgentOptions['mcpDnsValidationCache'] | undefined;
    mcpHostnameLookup?: RunAgentOptions['mcpHostnameLookup'];
    executionAdapter?: RunAgentOptions['executionAdapter'];
    executionAdapters?: RunAgentOptions['executionAdapters'];
    publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<unknown> | unknown;
    classifierConsult?: PermissionClassifierPromptConsultInput['classifierConsult'];
    warn(context: Record<string, unknown>, message: string): void;
}): {
    requestPermissionApproval: ChannelWiring['requestPermissionApproval'];
    requestUserAnswer: ChannelWiring['requestUserAnswer'];
};
