import { randomUUID } from 'node:crypto';

import type { CoreSendMessageDeps } from '../../application/core-tools/send-message.js';
import type { CoreTaskLifecycleBackend } from '../../application/core-tools/task-lifecycle.js';
import { runDurablePermissionInteraction } from '../../application/interactions/durable-interaction-handler.js';
import {
  classifyMcpToolAuditError,
  summarizeMcpToolArgumentPayload,
  summarizeMcpToolError,
} from '../../application/mcp/mcp-tool-audit.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import type { RuntimeAgentSessionRepository } from '../../domain/repositories/ops-repo.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type { AsyncTaskRepository } from '../../domain/ports/async-tasks.js';
import type {
  McpServerRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../../domain/types.js';
import type { InlineAgentLoopLaneInput } from '../../runtime/agent-inline.js';
import type { RunAgentOptions } from '../../runtime/agent-spawn-types.js';
import {
  resolveTurnSelectedMcpServerIds,
  resolveTurnSelectedSkillContext,
  resolveTurnSemanticCapabilities,
  resolveTurnToolPolicy,
} from '../../runtime/group-run-context.js';
import {
  createCoreToolRegistry,
  type CoreToolRegistryDeps,
} from '../../runtime/core-tools/registry.js';
import { createCoreToolSchemas } from '../../runtime/core-tools/schemas.js';
import {
  permissionDecisionEventType,
  permissionDecisionName,
  permissionTelemetryContext,
} from '../../runtime/ipc-permission-telemetry.js';
import {
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '../../shared/tool-execution-policy-service.js';
import type { YoloModeSettings } from '../../shared/yolo-mode-policy.js';
import type { ChannelWiring } from './channel-wiring-types.js';
import { createInlineAgentTaskLifecycle } from './inline-agent-task-lifecycle.js';
import type { RuntimeApp } from './runtime-app.js';

interface InlineCoreToolHostDeps extends CoreSendMessageDeps {
  requestUserAnswer: (
    request: UserQuestionRequest,
  ) => Promise<UserQuestionResponse>;
  requestPermissionApproval: (
    request: PermissionApprovalRequest,
  ) => Promise<PermissionApprovalDecision>;
  publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<void>;
  getAgentAccessPreset(folder: string): 'full' | 'locked';
  getYoloMode(): YoloModeSettings;
  getMcpServerRepository(): McpServerRepository | undefined;
  createTaskLifecycleBackend(
    laneInput: InlineAgentLoopLaneInput,
  ): CoreTaskLifecycleBackend | undefined;
}

type InlineCoreToolSupport = Pick<
  CoreToolRegistryDeps,
  | 'evaluateToolPreChecks'
  | 'evaluateToolPolicy'
  | 'formatMemorySearchResponse'
  | 'formatMemoryWriteResponse'
> & { schemaFactory: Parameters<typeof createCoreToolSchemas>[0] };

let inlineCoreToolHostDeps: InlineCoreToolHostDeps | undefined;

export function createInlineCoreTools(
  laneInput: InlineAgentLoopLaneInput,
  support: InlineCoreToolSupport,
): ReturnType<typeof createCoreToolRegistry> & {
  authorizeThirdPartyMcpTool(
    name: string,
    input: unknown,
    context?: { signal?: AbortSignal },
  ): Promise<{ allowed: boolean; reason?: string }>;
  recordThirdPartyMcpToolActivity(input: {
    serverName: string;
    toolName: string;
    toolInput: unknown;
    outcome: 'attempt' | 'success' | 'failure';
    latencyMs: number;
    error?: unknown;
  }): Promise<void>;
} {
  const deps = inlineCoreToolHostDeps;
  if (!deps) throw new Error('Inline core tool host is not configured.');
  const run = laneInput.input;
  const registry = createCoreToolRegistry({
    context: {
      sourceAgentFolder: laneInput.group.folder,
      conversationId: run.chatJid,
      appId: run.appId,
      agentId: run.agentId,
      providerAccountId: laneInput.group.providerAccountId,
      threadId: run.threadId,
      runId: run.runId,
      jobId: run.jobId,
      runLeaseToken: run.runLeaseToken,
      runLeaseFencingVersion: run.runLeaseFencingVersion,
      isScheduledJob: run.isScheduledJob,
      memoryDefaultScope: run.memoryDefaultScope,
      memoryUserId: run.memoryUserId,
      memoryBlock: run.memoryContextBlock,
      allowedToolRules: run.toolPolicyRules,
      yoloMode: run.yoloMode ?? deps.getYoloMode(),
      accessPreset: deps.getAgentAccessPreset(laneInput.group.folder),
    },
    sendMessage: deps.sendMessage,
    ...(deps.getFileArtifactStore
      ? { getFileArtifactStore: deps.getFileArtifactStore }
      : {}),
    requestUserAnswer: deps.requestUserAnswer,
    requestPermissionApproval: deps.requestPermissionApproval,
    publishRuntimeEvent: deps.publishRuntimeEvent,
    emitAgentOutput: laneInput.emitOutput,
    onPermissionPromptStarted: (request) =>
      laneInput.jobActivity.beginPermissionRequest(
        request.requestId,
        request.toolName,
      ),
    onPermissionPromptFinished: (request) =>
      laneInput.jobActivity.finishPermissionRequest(request.requestId),
    taskLifecycleBackend: deps.createTaskLifecycleBackend(laneInput),
    evaluateToolPreChecks: support.evaluateToolPreChecks,
    evaluateToolPolicy: support.evaluateToolPolicy,
    formatMemorySearchResponse: support.formatMemorySearchResponse,
    formatMemoryWriteResponse: support.formatMemoryWriteResponse,
    schemas: createCoreToolSchemas(support.schemaFactory),
  });
  const classifier = new ToolExecutionClassifier();
  const policy = new ToolExecutionPolicyService();
  return {
    ...registry,
    authorizeThirdPartyMcpTool: async (name, toolInput, context) => {
      context?.signal?.throwIfAborted();
      const precheck = support.evaluateToolPreChecks({
        toolName: name,
        toolInput,
        memoryBlock: run.memoryContextBlock ?? '',
        yoloMode: run.yoloMode ?? deps.getYoloMode(),
      });
      if (precheck) return { allowed: false, reason: precheck.reason };
      const decision = support.evaluateToolPolicy({
        classifier,
        policy,
        toolName: name,
        toolInput,
        context: {
          conversationId: run.chatJid,
          threadId: run.threadId,
          jobId: run.jobId,
          isScheduledJob: run.isScheduledJob,
          yoloMode: run.yoloMode ?? deps.getYoloMode(),
        },
        allowedToolRules: [
          ...(run.toolPolicyRules ?? []),
          ...laneInput.mcpServers.flatMap(
            ({ autoApproveToolNames }) => autoApproveToolNames,
          ),
        ],
      });
      if (decision.status === 'allow') return { allowed: true };
      if (deps.getAgentAccessPreset(laneInput.group.folder) === 'locked') {
        return {
          allowed: false,
          reason:
            'capability not provisioned: this agent runs with a locked access preset.',
        };
      }
      const request: PermissionApprovalRequest = {
        requestId: `permission-${randomUUID()}`,
        sourceAgentFolder: laneInput.group.folder,
        appId: run.appId,
        agentId: run.agentId,
        providerAccountId: laneInput.group.providerAccountId,
        jobId: run.jobId,
        runId: run.runId,
        runLeaseToken: run.runLeaseToken,
        runLeaseFencingVersion: run.runLeaseFencingVersion,
        targetJid: run.chatJid,
        threadId: run.threadId,
        toolName: name,
        displayName: name,
        description: 'Call a selected remote MCP tool.',
        decisionReason: decision.reason,
        closestRule: decision.closestRule,
        toolInput: toolInput as Record<string, unknown>,
        decisionOptions: ['allow_once', 'cancel'],
      };
      const interaction = await runDurablePermissionInteraction({
        request,
        sourceAgentFolder: laneInput.group.folder,
        beforePrompt: async () => {
          laneInput.jobActivity.beginPermissionRequest(
            request.requestId,
            request.toolName,
          );
          await laneInput.emitOutput({
            status: 'success',
            result: null,
            interactionBoundary: 'user_interaction',
          });
          await publishInlinePermissionEvent(
            deps,
            request,
            RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED,
            permissionTelemetryContext(request, {
              sourceAgentFolder: laneInput.group.folder,
              decision: 'requested',
            }),
          );
        },
        prompt: deps.requestPermissionApproval,
        afterDecision: async (permissionDecision) => {
          await publishInlinePermissionEvent(
            deps,
            request,
            permissionDecisionEventType(permissionDecision),
            permissionTelemetryContext(request, {
              sourceAgentFolder: laneInput.group.folder,
              decision: permissionDecisionName(permissionDecision),
              decisionMode: permissionDecision.mode,
              decidedBy: permissionDecision.decidedBy,
            }),
          );
          if (permissionDecision.approved) {
            await publishInlinePermissionEvent(
              deps,
              request,
              RUNTIME_EVENT_TYPES.PERMISSION_RESUMED,
              permissionTelemetryContext(request, {
                sourceAgentFolder: laneInput.group.folder,
                decision: 'resumed',
                decisionMode: permissionDecision.mode,
              }),
            );
          }
          await publishInlinePermissionEvent(
            deps,
            request,
            RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME,
            permissionTelemetryContext(request, {
              sourceAgentFolder: laneInput.group.folder,
              decision: permissionDecisionName(permissionDecision),
              approved: permissionDecision.approved,
              decisionMode: permissionDecision.mode,
            }),
          );
          laneInput.jobActivity.finishPermissionRequest(request.requestId);
        },
      });
      return interaction.resolved && interaction.decision.approved
        ? { allowed: true }
        : {
            allowed: false,
            reason:
              interaction.decision.reason ??
              'Remote MCP permission request was denied.',
          };
    },
    recordThirdPartyMcpToolActivity: async (activity) => {
      const repository = deps.getMcpServerRepository();
      const appId = run.appId;
      if (!repository || !appId) {
        throw new Error('Inline MCP audit repository is unavailable.');
      }
      const capability = laneInput.mcpServers.find(
        ({ name }) => name === activity.serverName,
      );
      const resultClass =
        activity.outcome === 'failure'
          ? classifyMcpToolAuditError(activity.error)
          : activity.outcome;
      const payload = {
        serverName: activity.serverName,
        toolName: activity.toolName,
        requestedToolRule: `mcp__${activity.serverName}__${activity.toolName}`,
        resultClass,
        latencyMs: activity.latencyMs,
        argumentSummary: summarizeMcpToolArgumentPayload(activity.toolInput),
        ...(activity.error
          ? { error: summarizeMcpToolError(activity.error) }
          : {}),
      };
      await repository.appendAuditEvent({
        id: `mcp-audit:${randomUUID()}` as never,
        appId: appId as never,
        agentId: run.agentId as never,
        serverId: capability?.serverId as never,
        bindingId: capability?.bindingId as never,
        eventType: 'tool_activity',
        actorId: 'inline-agent',
        metadata: payload,
        createdAt: new Date().toISOString() as never,
      });
      if (!deps.publishRuntimeEvent) return;
      await deps
        .publishRuntimeEvent({
          appId: appId as never,
          agentId: run.agentId as never,
          runId: run.runId as never,
          eventType: RUNTIME_EVENT_TYPES.MCP_TOOL_ACTIVITY,
          actor: 'inline-agent',
          responseMode: 'none',
          payload,
        })
        .catch(() => undefined);
    },
  };
}

export function wireInlineAgentLoopTools(input: {
  app: Pick<
    RuntimeApp,
    | 'executionAdapter'
    | 'executionAdapters'
    | 'runnerSandboxProvider'
    | 'getCredentialBroker'
    | 'getConversationRoutes'
    | 'resolveExecutionProviderId'
  >;
  channelWiring: ChannelWiring;
  interactionsEnabled: boolean;
  getAgentAccessPreset(folder: string): 'full' | 'locked';
  getYoloMode(): YoloModeSettings;
  getToolRepository?: () => ToolCatalogRepository | undefined;
  getFileArtifactStore?: CoreSendMessageDeps['getFileArtifactStore'];
  getMcpServerRepository?: () => McpServerRepository | undefined;
  getAsyncTaskRepository?: () => AsyncTaskRepository | undefined;
  opsRepository?: Pick<
    RuntimeAgentSessionRepository,
    'getAgentTurnContext' | 'createSessionAgentRun' | 'completeSessionAgentRun'
  >;
  getSkillRepository?: () => RunAgentOptions['skillRepository'];
  getSkillArtifactStore?: () => RunAgentOptions['skillArtifactStore'];
  getCapabilitySecretRepository?: () =>
    | RunAgentOptions['capabilitySecretRepository']
    | undefined;
  getMcpDnsValidationCache?: () =>
    | RunAgentOptions['mcpDnsValidationCache']
    | undefined;
  mcpHostnameLookup?: RunAgentOptions['mcpHostnameLookup'];
  executionAdapter?: RunAgentOptions['executionAdapter'];
  executionAdapters?: RunAgentOptions['executionAdapters'];
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;
  warn(context: Record<string, unknown>, message: string): void;
}): {
  requestPermissionApproval: ChannelWiring['requestPermissionApproval'];
  requestUserAnswer: ChannelWiring['requestUserAnswer'];
} {
  const reject = (kind: 'permission' | 'question'): never => {
    input.warn(
      { kind },
      'Rejecting interaction IPC on a worker without live-turn callbacks',
    );
    throw new Error(
      'This worker cannot receive provider interaction callbacks. Retry on a live-turn worker.',
    );
  };
  const requestPermissionApproval = (request: PermissionApprovalRequest) =>
    input.interactionsEnabled
      ? input.channelWiring.requestPermissionApproval(request)
      : Promise.reject(reject('permission'));
  const requestUserAnswer = (request: UserQuestionRequest) =>
    input.interactionsEnabled
      ? input.channelWiring.requestUserAnswer(request)
      : Promise.reject(reject('question'));
  inlineCoreToolHostDeps = {
    sendMessage: (jid, text, messageOptions) =>
      input.channelWiring.sendMessage(jid, text, {
        durability: 'required',
        throwOnMissing: true,
        ...(messageOptions ? { messageOptions } : {}),
      }),
    ...(input.getFileArtifactStore
      ? { getFileArtifactStore: input.getFileArtifactStore }
      : {}),
    requestPermissionApproval,
    requestUserAnswer,
    getAgentAccessPreset: input.getAgentAccessPreset,
    getYoloMode: input.getYoloMode,
    getMcpServerRepository: input.getMcpServerRepository ?? (() => undefined),
    createTaskLifecycleBackend: (laneInput) =>
      createInlineAgentTaskLifecycle({
        laneInput,
        repository: input.getAsyncTaskRepository?.(),
        runRepository: input.opsRepository,
        getConversationRoutes: input.app.getConversationRoutes,
        resolveExecutionProviderId: input.app.resolveExecutionProviderId,
        resolveRunAccess: async (agentId) => {
          const turnContext = laneInput.input.appId
            ? { appId: laneInput.input.appId, agentId }
            : undefined;
          const [toolPolicy, selectedSkills, semanticCapabilities] =
            await Promise.all([
              resolveTurnToolPolicy(input, turnContext),
              resolveTurnSelectedSkillContext(input, turnContext),
              resolveTurnSemanticCapabilities(input, turnContext),
            ]);
          return {
            toolPolicyRules: toolPolicy.toolPolicyRules,
            runtimeAccess: toolPolicy.runtimeAccess,
            attachedSkillSourceIds: selectedSkills.ids,
            selectedSkillDisplays: selectedSkills.displays,
            attachedMcpSourceIds: await resolveTurnSelectedMcpServerIds(
              input,
              turnContext,
              toolPolicy.toolPolicyRules,
            ),
            semanticCapabilities,
          };
        },
        buildRunOptions: async (agentId) => ({
          credentialBroker: await input.app.getCredentialBroker(),
          skillRepository: input.getSkillRepository?.(),
          skillArtifactStore: input.getSkillArtifactStore?.(),
          skillContext: laneInput.input.appId
            ? {
                appId: laneInput.input.appId,
                agentId,
              }
            : undefined,
          mcpServerRepository: input.getMcpServerRepository?.(),
          capabilitySecretRepository: input.getCapabilitySecretRepository?.(),
          mcpContext: laneInput.input.appId
            ? {
                appId: laneInput.input.appId,
                agentId,
              }
            : undefined,
          mcpHostnameLookup: input.mcpHostnameLookup,
          mcpDnsValidationCache: input.getMcpDnsValidationCache?.(),
          publishRuntimeEvent: input.publishRuntimeEvent,
          executionAdapter:
            input.executionAdapter ?? input.app.executionAdapter,
          executionAdapters:
            input.executionAdapters ?? input.app.executionAdapters,
          runnerSandboxProvider: input.app.runnerSandboxProvider,
          asyncTaskRepositoryAvailable: Boolean(
            input.getAsyncTaskRepository?.(),
          ),
        }),
      }),
    ...(input.publishRuntimeEvent
      ? {
          publishRuntimeEvent: async (event) => {
            await input.publishRuntimeEvent?.(event);
          },
        }
      : {}),
  };
  return { requestPermissionApproval, requestUserAnswer };
}

async function publishInlinePermissionEvent(
  deps: InlineCoreToolHostDeps,
  request: PermissionApprovalRequest,
  eventType: (typeof RUNTIME_EVENT_TYPES)[keyof typeof RUNTIME_EVENT_TYPES],
  payload: Record<string, unknown>,
): Promise<void> {
  if (!deps.publishRuntimeEvent || !request.appId) return;
  await deps
    .publishRuntimeEvent({
      appId: request.appId as never,
      agentId: request.agentId as never,
      runId: request.runId as never,
      jobId: request.jobId as never,
      conversationId: request.targetJid as never,
      threadId: request.threadId as never,
      eventType,
      actor: 'permission',
      correlationId: request.requestId,
      payload,
    })
    .catch(() => undefined);
}
