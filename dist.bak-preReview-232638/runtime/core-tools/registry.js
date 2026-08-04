import { randomUUID } from 'node:crypto';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { ToolExecutionClassifier, ToolExecutionPolicyService, } from '../../shared/tool-execution-policy-service.js';
import { readWorkspaceMessageAttachment } from '../../platform/workspace-message-attachment.js';
import { processMemoryRequest } from '../../memory/memory-ipc.js';
import { runDurableQuestionInteraction, } from '../../application/interactions/durable-interaction-handler.js';
import { sendCoreMessage, } from '../../application/core-tools/send-message.js';
import { coreTaskLifecycleMcpResult, createCallableAgentToolDefinitions, isCallableAgentToolName, } from '../../application/core-tools/callable-agent-tools.js';
import { coordinateCoreToolPermission } from './core-tool-permission-coordinator.js';
import { formatPermissionDeniedMessage } from '../../shared/permission-decision-message.js';
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
];
const MCP_INVENTORY_TOOL_NAMES = [
    'mcp_list_tools',
    'mcp_search_tools',
    'mcp_describe_tool',
    'mcp_call_tool',
];
export function inlineCoreToolsMountMcpInventory() {
    const mounted = new Set(CORE_TOOL_NAMES);
    return MCP_INVENTORY_TOOL_NAMES.every((name) => mounted.has(name));
}
export function createCoreToolRegistry(deps) {
    const id = deps.requestId ?? ((prefix) => `${prefix}-${randomUUID()}`);
    const definitions = [
        define('send_message', 'Send a message in the active conversation.', deps.schemas.send_message, async (args) => {
            const result = await sendCoreMessage({
                deps: {
                    ...deps,
                    readWorkspaceAttachment: readWorkspaceMessageAttachment,
                },
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
        }),
        define('ask_user_question', 'Ask the user a structured multiple-choice question.', deps.schemas.ask_user_question, async (args) => {
            const request = {
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
                beforePrompt: () => deps.emitAgentOutput?.({
                    status: 'success',
                    result: null,
                    interactionBoundary: 'user_interaction',
                }),
                prompt: deps.requestUserAnswer,
            });
            if (!result.resolved)
                return errorResult('Question resolution could not be persisted.');
            return textResult(formatQuestionAnswers(result.response.answers, result.response.answeredBy));
        }),
        define('memory_search', 'Search durable scoped memory.', deps.schemas.memory_search, async (args) => memoryResult('memory_search', args, deps, id)),
        define('memory_save', 'Save a durable scoped memory statement.', deps.schemas.memory_save, async (args) => memoryResult('memory_save', {
            ...args,
            scope: args.scope ?? deps.context.memoryDefaultScope ?? 'group',
        }, deps, id)),
        ...Object.entries({
            delegate_task: deps.schemas.delegate_task,
            task_get: deps.schemas.task_get,
            task_list: deps.schemas.task_list,
            task_cancel: deps.schemas.task_cancel,
            task_message: deps.schemas.task_message,
        }).map(([name, schema]) => define(name, taskDescription(name), schema, async (args) => {
            if (!deps.taskLifecycleBackend) {
                return errorResult('Async task runtime is unavailable.', 'transient', true);
            }
            return coreTaskLifecycleMcpResult(await deps.taskLifecycleBackend[name]({ ...args }));
        })),
        ...(deps.dispatchCallableAgent
            ? createCallableAgentToolDefinitions({
                manifest: deps.callableAgentManifest ?? [],
                schema: deps.schemas.callable_agent,
                dispatch: deps.dispatchCallableAgent,
            })
            : []),
    ];
    const byName = Object.fromEntries(definitions.map((tool) => [tool.name, tool]));
    return {
        tools: definitions,
        byName,
        get: (name) => byName[name],
        execute: async (name, input, context) => {
            const tool = byName[name];
            if (!tool)
                return errorResult(`Unknown core tool: ${name}`, 'validation', false);
            const parsed = tool.inputSchema.safeParse(input);
            if (!parsed.success) {
                return errorResult(parsed.error.issues[0]?.message ?? 'Invalid tool input.', 'validation', false);
            }
            if (deps.context.toolRules?.length) {
                const ruleName = isCallableAgentToolName(name)
                    ? 'AgentDelegation'
                    : name;
                const denial = deps.evaluateToolPreChecks({
                    toolName: ruleName,
                    toolInput: parsed.data,
                    memoryBlock: deps.context.memoryBlock ?? '',
                    yoloMode: deps.context.yoloMode,
                    toolRules: deps.context.toolRules,
                    successLedger: deps.context.toolSuccessLedger,
                });
                if (denial) {
                    const error = denial.error ?? {
                        category: 'permission',
                        isRetryable: false,
                        message: denial.reason,
                    };
                    if (deps.context.isScheduledJob &&
                        deps.context.jobId &&
                        deps.publishRuntimeEvent) {
                        await deps
                            .publishRuntimeEvent({
                            appId: deps.context.appId,
                            agentId: deps.context.agentId,
                            runId: deps.context.runId,
                            jobId: deps.context.jobId,
                            conversationId: deps.context.conversationId,
                            threadId: deps.context.threadId,
                            eventType: RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
                            actor: 'inline-agent',
                            responseMode: 'none',
                            payload: {
                                phase: 'deny',
                                tool: ruleName,
                                ok: false,
                                reason: error.message,
                                error,
                            },
                        })
                            .catch(() => undefined);
                    }
                    return {
                        content: [{ type: 'text', text: error.message }],
                        isError: true,
                        error,
                    };
                }
            }
            const gate = await gateCoreTool(name, parsed.data, deps, id);
            if (gate?.denied)
                return gate.denied;
            try {
                const result = await tool.handler(parsed.data, context);
                if (!result.isError) {
                    const gateName = coreToolGateName(name);
                    if (!isCallableAgentToolName(name)) {
                        deps.context.toolSuccessLedger?.recordSuccess(name);
                    }
                    if (gateName)
                        deps.context.toolSuccessLedger?.recordSuccess(gateName);
                }
                return gate?.approvalContext
                    ? withPermissionApprovalContext(result, gate.approvalContext)
                    : result;
            }
            catch (error) {
                const result = errorResult(error instanceof Error ? error.message : String(error), 'transient', true);
                return gate?.approvalContext
                    ? withPermissionApprovalContext(result, gate.approvalContext)
                    : result;
            }
        },
    };
}
function define(name, description, inputSchema, handler) {
    return {
        name,
        description,
        inputSchema: inputSchema,
        handler: (input, context) => handler(input, context),
    };
}
async function gateCoreTool(name, args, deps, id) {
    const gateName = coreToolGateName(name);
    if (!gateName)
        return null;
    const precheck = deps.evaluateToolPreChecks({
        toolName: gateName,
        toolInput: args,
        memoryBlock: deps.context.memoryBlock ?? '',
        yoloMode: deps.context.yoloMode,
        toolRules: deps.context.toolRules,
        successLedger: deps.context.toolSuccessLedger,
    });
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
    // Auto classifier omitted: only ineligible AgentDelegation reaches this seam.
    const request = {
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
        decisionReason: precheck?.reason ?? decision.reason,
        closestRule: decision.closestRule,
        toolInput: args,
        suggestions: [
            {
                type: 'addRules',
                behavior: 'allow',
                rules: [{ toolName: gateName }],
                destination: 'session',
            },
        ],
        decisionOptions: ['allow_once', 'allow_persistent_rule', 'cancel'],
    };
    const coordinatedDecision = await coordinateCoreToolPermission({
        request,
        hardDenyReason: precheck?.reason,
        reviewedRuleDecision: decision,
        deps,
    });
    if (!coordinatedDecision.approved && precheck?.error) {
        return {
            denied: errorResult(precheck.error.message, precheck.error.category, precheck.error.isRetryable),
        };
    }
    return coordinatedDecision.approved
        ? {
            approvalContext: formatPermissionAllowedMessage(coordinatedDecision),
        }
        : { denied: permissionDenied(coordinatedDecision) };
}
function coreToolGateName(name) {
    return name === 'delegate_task' ||
        name === 'task_message' ||
        isCallableAgentToolName(name)
        ? 'AgentDelegation'
        : null;
}
async function memoryResult(action, payload, deps, id) {
    const response = await processMemoryRequest({
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
    }, deps.context.sourceAgentFolder);
    if (!response.ok) {
        return errorResult(`${action === 'memory_search' ? 'Memory search' : 'Memory save'} failed: ${response.error || 'unknown error'}`);
    }
    return textResult(action === 'memory_search'
        ? deps.formatMemorySearchResponse(response)
        : deps.formatMemoryWriteResponse(action, response));
}
function formatQuestionAnswers(answers, answeredBy) {
    const lines = Object.entries(answers).map(([question, answer]) => `${question}: ${Array.isArray(answer) ? answer.join(', ') : answer}`);
    if (answeredBy?.trim())
        lines.push(`(answered by ${answeredBy.trim()})`);
    return lines.join('\n') || 'No answer received.';
}
function taskDescription(name) {
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
function textResult(text) {
    return { content: [{ type: 'text', text }] };
}
function errorResult(text, category = 'transient', isRetryable = true) {
    return {
        content: [{ type: 'text', text }],
        isError: true,
        error: { category, isRetryable, message: text },
    };
}
function permissionDenied(decision) {
    const reason = decision.reason ?? 'request cancelled';
    return errorResult(formatPermissionDeniedMessage(decision, reason), 'permission', false);
}
function formatPermissionAllowedMessage(decision) {
    if (decision.decidedBy === 'birthright' ||
        decision.decidedBy === 'deterministic_read_only') {
        return undefined;
    }
    if (!decision.decidedBy && !decision.risk_level)
        return undefined;
    return formatPermissionDeniedMessage(decision, '')
        .replace(/^Permission denied/, 'Permission allowed')
        .replace(/: $/, '');
}
function withPermissionApprovalContext(result, approvalContext) {
    return {
        ...result,
        content: [{ type: 'text', text: approvalContext }, ...result.content],
    };
}
