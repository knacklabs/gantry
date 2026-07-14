import { randomUUID } from 'node:crypto';

import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  UserQuestionRequest,
} from '../../domain/types.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import {
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
  type ToolPolicyDecision,
} from '../../shared/tool-execution-policy-service.js';
import type { YoloModeSettings } from '../../shared/yolo-mode-policy.js';
import {
  permissionDecisionEventType,
  permissionDecisionName,
  permissionTelemetryContext,
} from '../ipc-permission-telemetry.js';
import { processMemoryRequest } from '../../memory/memory-ipc.js';
import {
  runDurablePermissionInteraction,
  runDurableQuestionInteraction,
  type DurableInteractionOperations,
} from '../../application/interactions/durable-interaction-handler.js';
import {
  sendCoreMessage,
  type CoreSendMessageDeps,
} from '../../application/core-tools/send-message.js';
import {
  coreTaskLifecycleResultText,
  type CoreTaskLifecycleBackend,
  type CoreTaskLifecycleErrorCode,
  type CoreTaskLifecycleName,
} from '../../application/core-tools/task-lifecycle.js';
import type {
  CoreToolInputByName,
  CoreToolInputSchema,
  CoreToolSchemas,
} from './schemas.js';

export const CORE_TOOL_NAMES = [
  'send_message',
  'ask_user_question',
  'memory_search',
  'memory_save',
  'delegate_task',
  'task_get',
  'task_list',
  'task_cancel',
  'task_message',
] as const;
export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];

const LOCKED_ACCESS_PRESET_DENY_REASON =
  'capability not provisioned: this agent runs with a locked access preset and cannot request new tools, skills, MCP servers, or permissions. Provision the capability before the run.';

export interface McpCompatibleToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  error?: McpCompatibleToolError;
}

export interface McpCompatibleToolError {
  category: 'transient' | 'validation' | 'business' | 'permission';
  isRetryable: boolean;
  message: string;
}

export interface CoreToolHandlerContext {
  signal?: AbortSignal;
}

export interface CoreToolDefinition {
  name: CoreToolName;
  description: string;
  inputSchema: CoreToolInputSchema<Record<string, unknown>>;
  handler: (
    input: Record<string, unknown>,
    context?: CoreToolHandlerContext,
  ) => Promise<McpCompatibleToolResult>;
}

export interface CoreToolRunContext {
  sourceAgentFolder: string;
  conversationId: string;
  appId?: string;
  agentId?: string;
  providerAccountId?: string;
  threadId?: string;
  runId?: string;
  jobId?: string;
  runLeaseToken?: string;
  runLeaseFencingVersion?: number;
  isScheduledJob?: boolean;
  memoryDefaultScope?: 'user' | 'group';
  memoryUserId?: string;
  memoryBlock?: string;
  allowedToolRules?: readonly string[];
  autonomousAllowedToolRules?: readonly string[];
  yoloMode?: YoloModeSettings;
  accessPreset?: 'full' | 'locked';
}

export interface CoreToolRegistryDeps extends CoreSendMessageDeps {
  context: CoreToolRunContext;
  requestUserAnswer: (request: UserQuestionRequest) => Promise<{
    requestId: string;
    answers: Record<string, string | string[]>;
    answeredBy?: string;
  }>;
  requestPermissionApproval?: (
    request: PermissionApprovalRequest,
  ) => Promise<PermissionApprovalDecision>;
  publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<void>;
  emitAgentOutput?: (output: {
    status: 'success';
    result: null;
    interactionBoundary: 'user_interaction';
  }) => Promise<void> | void;
  taskLifecycleBackend?: CoreTaskLifecycleBackend;
  onPermissionDecision?: (
    request: PermissionApprovalRequest,
    decision: PermissionApprovalDecision,
  ) => Promise<void> | void;
  onPermissionPromptStarted?: (
    request: PermissionApprovalRequest,
  ) => Promise<void> | void;
  onPermissionPromptFinished?: (
    request: PermissionApprovalRequest,
  ) => Promise<void> | void;
  durability?: DurableInteractionOperations;
  requestId?: (prefix: string) => string;
  evaluateToolPreChecks(input: {
    toolName: string;
    toolInput: unknown;
    memoryBlock: string;
    yoloMode?: YoloModeSettings;
  }): { reason: string } | null;
  evaluateToolPolicy(input: {
    classifier: ToolExecutionClassifier;
    policy: ToolExecutionPolicyService;
    toolName: string;
    toolInput: unknown;
    context: {
      conversationId: string;
      threadId?: string;
      jobId?: string;
      isScheduledJob?: boolean;
      yoloMode?: YoloModeSettings;
    };
    allowedToolRules: readonly string[];
    autonomousAllowedToolRules?: readonly string[];
  }): ToolPolicyDecision;
  formatMemorySearchResponse(response: {
    provider?: string;
    data?: unknown;
  }): string;
  formatMemoryWriteResponse(
    action: string,
    response: { provider?: string; data?: unknown },
  ): string;
  schemas: CoreToolSchemas;
}

export function createCoreToolRegistry(deps: CoreToolRegistryDeps): {
  tools: readonly CoreToolDefinition[];
  byName: Readonly<Record<CoreToolName, CoreToolDefinition>>;
  get(name: string): CoreToolDefinition | undefined;
  execute(
    name: CoreToolName,
    input: unknown,
    context?: CoreToolHandlerContext,
  ): Promise<McpCompatibleToolResult>;
} {
  const id =
    deps.requestId ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
  const definitions: CoreToolDefinition[] = [
    define(
      'send_message',
      'Send a message in the active conversation.',
      deps.schemas.send_message,
      async (args) => {
        const result = await sendCoreMessage({
          deps,
          context: {
            appId: deps.context.appId,
            sourceAgentFolder: deps.context.sourceAgentFolder,
            targetJid: deps.context.conversationId,
            threadId: deps.context.threadId,
            providerAccountId: deps.context.providerAccountId,
            isScheduledJob: deps.context.isScheduledJob,
          },
          message: args,
        });
        return textResult(result.message);
      },
    ),
    define(
      'ask_user_question',
      'Ask the user a structured multiple-choice question.',
      deps.schemas.ask_user_question,
      async (args) => {
        const request: UserQuestionRequest = {
          requestId: id('userq'),
          sourceAgentFolder: deps.context.sourceAgentFolder,
          appId: deps.context.appId,
          agentId: deps.context.agentId,
          providerAccountId: deps.context.providerAccountId,
          jobId: deps.context.jobId,
          runId: deps.context.runId,
          runLeaseToken: deps.context.runLeaseToken,
          runLeaseFencingVersion: deps.context.runLeaseFencingVersion,
          targetJid: deps.context.conversationId,
          threadId: deps.context.threadId,
          questions: args.questions.map((question) => ({
            ...question,
            multiSelect: Boolean(question.multiSelect),
          })),
        };
        const result = await runDurableQuestionInteraction({
          request,
          sourceAgentFolder: deps.context.sourceAgentFolder,
          operations: deps.durability,
          beforePrompt: () =>
            deps.emitAgentOutput?.({
              status: 'success',
              result: null,
              interactionBoundary: 'user_interaction',
            }),
          prompt: deps.requestUserAnswer,
        });
        if (!result.resolved)
          return errorResult('Question resolution could not be persisted.');
        return textResult(
          formatQuestionAnswers(
            result.response.answers,
            result.response.answeredBy,
          ),
        );
      },
    ),
    define(
      'memory_search',
      'Search durable scoped memory.',
      deps.schemas.memory_search,
      async (args) => memoryResult('memory_search', args, deps, id),
    ),
    define(
      'memory_save',
      'Save a durable scoped memory statement.',
      deps.schemas.memory_save,
      async (args) =>
        memoryResult(
          'memory_save',
          {
            ...args,
            scope: args.scope ?? deps.context.memoryDefaultScope ?? 'group',
          },
          deps,
          id,
        ),
    ),
    ...(
      Object.entries({
        delegate_task: deps.schemas.delegate_task,
        task_get: deps.schemas.task_get,
        task_list: deps.schemas.task_list,
        task_cancel: deps.schemas.task_cancel,
        task_message: deps.schemas.task_message,
      }) as Array<
        [
          CoreTaskLifecycleName,
          CoreToolInputSchema<CoreToolInputByName[CoreTaskLifecycleName]>,
        ]
      >
    ).map(([name, schema]) =>
      define(name, taskDescription(name), schema, async (args) => {
        if (!deps.taskLifecycleBackend) {
          return errorResult(
            'Async task runtime is unavailable.',
            'transient',
            true,
          );
        }
        const result = await deps.taskLifecycleBackend[name]({ ...args });
        const text = coreTaskLifecycleResultText(result);
        return {
          content: [{ type: 'text', text }],
          ...(result.ok
            ? {}
            : {
                isError: true,
                error: taskLifecycleError(result.code, text),
              }),
        };
      }),
    ),
  ];
  const byName = Object.fromEntries(
    definitions.map((tool) => [tool.name, tool]),
  ) as Record<CoreToolName, CoreToolDefinition>;
  return {
    tools: definitions,
    byName,
    get: (name) => byName[name as CoreToolName],
    execute: async (name, input, context) => {
      const tool = byName[name];
      if (!tool)
        return errorResult(`Unknown core tool: ${name}`, 'validation', false);
      const parsed = tool.inputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(
          parsed.error.issues[0]?.message ?? 'Invalid tool input.',
          'validation',
          false,
        );
      }
      const gate = await gateCoreTool(name, parsed.data, deps, id);
      if (gate) return gate;
      try {
        return await tool.handler(parsed.data, context);
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
          'transient',
          true,
        );
      }
    },
  };
}

function define<Name extends CoreToolName>(
  name: Name,
  description: string,
  inputSchema: CoreToolInputSchema<CoreToolInputByName[Name]>,
  handler: (
    input: CoreToolInputByName[Name],
    context?: CoreToolHandlerContext,
  ) => Promise<McpCompatibleToolResult>,
): CoreToolDefinition {
  return {
    name,
    description,
    inputSchema: inputSchema as CoreToolInputSchema<Record<string, unknown>>,
    handler: (input, context) =>
      handler(input as CoreToolInputByName[Name], context),
  };
}

async function gateCoreTool(
  name: CoreToolName,
  args: unknown,
  deps: CoreToolRegistryDeps,
  id: (prefix: string) => string,
): Promise<McpCompatibleToolResult | null> {
  const gateName =
    name === 'delegate_task' || name === 'task_message'
      ? 'AgentDelegation'
      : null;
  if (!gateName) return null;
  const precheck = deps.evaluateToolPreChecks({
    toolName: gateName,
    toolInput: args,
    memoryBlock: deps.context.memoryBlock ?? '',
    yoloMode: deps.context.yoloMode,
  });
  if (precheck) return permissionDenied(precheck.reason);
  const decision = deps.evaluateToolPolicy({
    classifier: new ToolExecutionClassifier(),
    policy: new ToolExecutionPolicyService(),
    toolName: gateName,
    toolInput: args,
    context: {
      conversationId: deps.context.conversationId,
      threadId: deps.context.threadId,
      jobId: deps.context.jobId,
      isScheduledJob: deps.context.isScheduledJob,
      yoloMode: deps.context.yoloMode,
    },
    allowedToolRules: deps.context.allowedToolRules ?? [],
    autonomousAllowedToolRules: deps.context.autonomousAllowedToolRules,
  });
  if (decision.status === 'allow') return null;
  if (deps.context.accessPreset === 'locked') {
    return permissionDenied(LOCKED_ACCESS_PRESET_DENY_REASON);
  }

  const request: PermissionApprovalRequest = {
    requestId: id('permission'),
    sourceAgentFolder: deps.context.sourceAgentFolder,
    appId: deps.context.appId,
    agentId: deps.context.agentId,
    jobId: deps.context.jobId,
    runId: deps.context.runId,
    runLeaseToken: deps.context.runLeaseToken,
    runLeaseFencingVersion: deps.context.runLeaseFencingVersion,
    targetJid: deps.context.conversationId,
    threadId: deps.context.threadId,
    toolName: gateName,
    displayName: gateName,
    description: 'Start or steer a delegated Gantry task.',
    decisionReason: decision.reason,
    closestRule: decision.closestRule,
    toolInput: args as Record<string, unknown>,
    suggestions: [
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: gateName }],
        destination: 'session',
      },
    ],
    decisionOptions: deps.context.isScheduledJob
      ? ['allow_once', 'allow_persistent_rule', 'cancel']
      : ['allow_once', 'allow_timed_grant', 'allow_persistent_rule', 'cancel'],
  };
  const interaction = await runDurablePermissionInteraction({
    request,
    sourceAgentFolder: deps.context.sourceAgentFolder,
    operations: deps.durability,
    beforePrompt: async () => {
      await deps.onPermissionPromptStarted?.(request);
      await publishPermissionEvent(
        deps,
        request,
        RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED,
        permissionTelemetryContext(request, {
          sourceAgentFolder: deps.context.sourceAgentFolder,
          decision: 'requested',
        }),
      );
    },
    prompt: async () =>
      deps.requestPermissionApproval?.(request) ?? {
        approved: false,
        mode: 'cancel',
        reason: 'approval surface unavailable',
      },
    afterDecision: async (permissionDecision) => {
      await deps.onPermissionDecision?.(request, permissionDecision);
      await publishPermissionEvent(
        deps,
        request,
        permissionDecisionEventType(permissionDecision),
        permissionTelemetryContext(request, {
          sourceAgentFolder: deps.context.sourceAgentFolder,
          decision: permissionDecisionName(permissionDecision),
          decisionMode: permissionDecision.mode,
          decidedBy: permissionDecision.decidedBy,
        }),
      );
      if (permissionDecision.approved) {
        await publishPermissionEvent(
          deps,
          request,
          RUNTIME_EVENT_TYPES.PERMISSION_RESUMED,
          permissionTelemetryContext(request, {
            sourceAgentFolder: deps.context.sourceAgentFolder,
            decision: 'resumed',
            decisionMode: permissionDecision.mode,
          }),
        );
      }
      await publishPermissionEvent(
        deps,
        request,
        RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME,
        permissionTelemetryContext(request, {
          sourceAgentFolder: deps.context.sourceAgentFolder,
          decision: permissionDecisionName(permissionDecision),
          approved: permissionDecision.approved,
          decisionMode: permissionDecision.mode,
        }),
      );
      await deps.onPermissionPromptFinished?.(request);
    },
  });
  if (!interaction.resolved) {
    return permissionDenied('durable permission resolution failed');
  }
  return interaction.decision.approved
    ? null
    : permissionDenied(interaction.decision.reason ?? 'request cancelled');
}

async function memoryResult(
  action: 'memory_search' | 'memory_save',
  payload: Record<string, unknown>,
  deps: CoreToolRegistryDeps,
  id: (prefix: string) => string,
): Promise<McpCompatibleToolResult> {
  const response = await processMemoryRequest(
    {
      requestId: id('memory'),
      action,
      payload,
      allowedActions: ['memory_search', 'memory_save'],
      context: {
        chatJid: deps.context.conversationId,
        threadId: deps.context.threadId,
        userId: deps.context.memoryUserId,
        defaultScope: deps.context.memoryDefaultScope ?? 'group',
      },
    },
    deps.context.sourceAgentFolder,
  );
  if (!response.ok) {
    return errorResult(
      `${action === 'memory_search' ? 'Memory search' : 'Memory save'} failed: ${response.error || 'unknown error'}`,
    );
  }
  return textResult(
    action === 'memory_search'
      ? deps.formatMemorySearchResponse(response)
      : deps.formatMemoryWriteResponse(action, response),
  );
}

async function publishPermissionEvent(
  deps: CoreToolRegistryDeps,
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

function formatQuestionAnswers(
  answers: Record<string, string | string[]>,
  answeredBy?: string,
): string {
  const lines = Object.entries(answers).map(
    ([question, answer]) =>
      `${question}: ${Array.isArray(answer) ? answer.join(', ') : answer}`,
  );
  if (answeredBy?.trim()) lines.push(`(answered by ${answeredBy.trim()})`);
  return lines.join('\n') || 'No answer received.';
}

function taskDescription(name: CoreTaskLifecycleName): string {
  switch (name) {
    case 'delegate_task':
      return 'Start a durable child Gantry agent task.';
    case 'task_get':
      return 'Read one durable task.';
    case 'task_list':
      return 'List recent durable tasks.';
    case 'task_cancel':
      return 'Cancel one running durable task.';
    case 'task_message':
      return 'Send a steering message to a delegated task.';
  }
}

function textResult(text: string): McpCompatibleToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(
  text: string,
  category: McpCompatibleToolError['category'] = 'transient',
  isRetryable = true,
): McpCompatibleToolResult {
  return {
    content: [{ type: 'text', text }],
    isError: true,
    error: { category, isRetryable, message: text },
  };
}

function permissionDenied(reason: string): McpCompatibleToolResult {
  return errorResult(`Permission denied: ${reason}`, 'permission', false);
}

function taskLifecycleError(
  code: CoreTaskLifecycleErrorCode | undefined,
  message: string,
): McpCompatibleToolError {
  switch (code) {
    case 'unavailable':
      return { category: 'transient', isRetryable: true, message };
    case 'invalid_request':
      return { category: 'validation', isRetryable: false, message };
    case 'forbidden':
      return { category: 'permission', isRetryable: false, message };
    case 'not_found':
    default:
      return { category: 'business', isRetryable: false, message };
  }
}
