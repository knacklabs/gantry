import type { CoreSendMessageDeps } from '../../application/core-tools/send-message.js';
import type { CoreTaskLifecycleBackend } from '../../application/core-tools/task-lifecycle.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import type { PermissionPromotionRepository } from '../../domain/ports/permission-promotion.js';
import type {
  AgentRepository,
  McpServerRepository,
} from '../../domain/ports/repositories.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../../domain/types.js';
import type { InlineAgentLoopLaneInput } from '../../runtime/agent-inline.js';
import type { PermissionClassifierPromptConsultInput } from '../../runtime/permission-classifier.js';
import type { CoreToolRegistryDeps } from '../../runtime/core-tools/registry.js';
import type { createCoreToolSchemas } from '../../runtime/core-tools/schemas.js';
import type { YoloModeSettings } from '../../shared/yolo-mode-policy.js';
import type { InlineConfiguredAgents } from './inline-callable-agent-tools.js';

export interface InlineCoreToolHostDeps extends CoreSendMessageDeps {
  warn(context: Record<string, unknown>, message: string): void;
  requestUserAnswer(
    request: UserQuestionRequest,
  ): Promise<UserQuestionResponse>;
  requestPermissionApproval: (
    request: PermissionApprovalRequest,
  ) => Promise<PermissionApprovalDecision>;
  publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<void>;
  classifierConsult?: PermissionClassifierPromptConsultInput['classifierConsult'];
  getAgentAccessPreset(folder: string): 'full' | 'locked';
  getConversationRoutes(): Record<
    string,
    import('../../domain/types.js').ConversationRoute
  >;
  getPermissionRuntimeSettings(): {
    agents?: InlineConfiguredAgents;
    permissions: {
      autoMode: { model?: string };
      yoloMode: YoloModeSettings;
    };
    memory: { llm: { models: { extractor: string } } };
  };
  getMcpServerRepository(): McpServerRepository | undefined;
  getAgentRepository(): AgentRepository | undefined;
  getPermissionPromotionRepository(): PermissionPromotionRepository | undefined;
  createTaskLifecycleBackend(
    laneInput: InlineAgentLoopLaneInput,
    authorityToolName?: 'AgentDelegation',
  ): CoreTaskLifecycleBackend | undefined;
}

export type InlineCoreToolSupport = Pick<
  CoreToolRegistryDeps,
  | 'evaluateToolPreChecks'
  | 'evaluateToolPolicy'
  | 'formatMemorySearchResponse'
  | 'formatMemoryWriteResponse'
> & { schemaFactory: Parameters<typeof createCoreToolSchemas>[0] };
