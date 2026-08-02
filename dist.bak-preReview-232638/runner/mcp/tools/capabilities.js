import { z } from 'zod';
import { validateSemanticCapabilityDefinition, } from '../../../shared/semantic-capabilities.js';
import { SOURCE_INVENTORY_AUTHORITY_GUIDANCE } from '../../../shared/capability-guidance.js';
import { isGantryFacadeExactToolName, parseReadableScopedToolRule, RUN_COMMAND_TOOL_NAME, validateReadableAgentToolRule, } from '../../../shared/agent-tool-references.js';
import { validateDurableAccessRule } from '../../../shared/durable-access-policy.js';
import { adminMcpToolFullName, isAdminMcpToolFullName, isAdminMcpToolName, } from '../../../shared/admin-mcp-tools.js';
const CapabilityTargetSchema = z.object({
    kind: z.literal('capability'),
    id: z
        .string()
        .min(1)
        .describe('Reviewed semantic capability id, such as app.resource.action'),
});
const RunCommandTargetSchema = z.object({
    kind: z.literal('run_command'),
    argvPattern: z
        .string()
        .min(1)
        .describe('Scoped command pattern for a persistent RunCommand fallback, such as "npm test *" or "git status". Never broad "cli *".'),
});
const ExactToolTargetSchema = z.object({
    kind: z.literal('tool'),
    name: z
        .string()
        .min(1)
        .describe('Exact durable Gantry tool rule, such as AgentDelegation or mcp__gantry__request_settings_update. Use run_command for scoped commands.'),
});
export function registerAccessRequestTool(server, submitCapabilityReviewTask, options = {}) {
    server.tool('request_access', [
        'Request agent access for review. Use this as the normal path when an action is missing.',
        'target.kind=capability requests an already-reviewed semantic capability by id.',
        'target.kind=tool requests an exact durable Gantry tool rule such as AgentDelegation or mcp__gantry__request_settings_update.',
        'target.kind=run_command requests a scoped temporary exact-command fallback such as "npm test *" when no reviewed capability fits.',
        'Set temporaryOnly=true for one-off transient access; leave it false for durable grants.',
        'Source setup and raw skill, MCP, CLI, browser, or network details are review metadata, not durable authority.',
    ].join(' '), {
        target: z.discriminatedUnion('kind', [
            CapabilityTargetSchema,
            ExactToolTargetSchema,
            RunCommandTargetSchema,
        ]),
        reason: z.string().describe('Why this access is needed'),
        temporaryOnly: z
            .boolean()
            .optional()
            .describe('One-off/transient access for the current action only'),
        broadAccess: z
            .boolean()
            .optional()
            .describe('Reviewer signal that the requested access is broad'),
        riskClass: z
            .enum(['low', 'medium', 'high', 'critical'])
            .optional()
            .describe('Requested risk classification. Broad shell, edit/write, network, credential, service, or wildcard MCP access should be high or critical.'),
    }, async (args) => {
        const { target } = args;
        switch (target.kind) {
            case 'capability': {
                const approved = (await availableSemanticCapabilities(options)).find((candidate) => candidate.capabilityId === target.id);
                if (!approved) {
                    const toolName = normalizeExactRequestableToolName(target.id);
                    if (toolName) {
                        return submitExactToolRequest({
                            toolName,
                            args,
                            options,
                            submitCapabilityReviewTask,
                        });
                    }
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: [
                                    `No reviewed capability matches id "${target.id}".`,
                                    'Use the Agent Access summary in your run context to find a valid capability id. If setup is missing, request source setup through the Gantry access flow.',
                                    SOURCE_INVENTORY_AUTHORITY_GUIDANCE,
                                ].join('\n'),
                            },
                        ],
                    };
                }
                if (options.isCapabilitySelected?.(approved.capabilityId)) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: [
                                    `Capability "${approved.displayName}" is already selected for this run.`,
                                    'Use the available action directly instead of requesting the same access again.',
                                    approved.implementationBindings.some((binding) => binding.kind === 'mcp_tool' ||
                                        binding.kind === 'mcp_pattern')
                                        ? 'For MCP sources, use mcp_list_tools to inspect the ready source, mcp_describe_tool for one tool schema if needed, then mcp_call_tool to call the approved action.'
                                        : 'Check capability_status if you need to confirm current access.',
                                ].join('\n'),
                            },
                        ],
                    };
                }
                return submitCapabilityReviewTask('request_permission', 'Capability', {
                    permissionKind: 'tool',
                    capabilityRequestSource: 'request_access',
                    capabilityId: approved.capabilityId,
                    capabilityDisplayName: approved.displayName,
                    accountLabel: approved.accountLabel,
                    can: approved.can,
                    cannot: approved.cannot,
                    credentialSource: approved.credentialSource,
                    risk: approved.risk,
                    ...(approved.networkHosts?.length
                        ? { networkHosts: approved.networkHosts }
                        : {}),
                    temporaryOnly: args.temporaryOnly ?? false,
                    broadAccess: args.broadAccess,
                    riskClass: args.riskClass,
                    reason: args.reason,
                });
            }
            case 'tool': {
                const toolName = normalizeExactRequestableToolName(target.name);
                if (!toolName) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: [
                                    `No exact requestable Gantry tool matches "${target.name}".`,
                                    'Use target.kind=tool only for exact Gantry facade tools such as AgentDelegation or exact Gantry admin tools such as mcp__gantry__request_settings_update.',
                                    'Use target.kind=capability for reviewed semantic capability ids, and target.kind=run_command for scoped command access.',
                                ].join('\n'),
                            },
                        ],
                    };
                }
                return submitExactToolRequest({
                    toolName,
                    args,
                    options,
                    submitCapabilityReviewTask,
                });
            }
            case 'run_command': {
                const rule = `${RUN_COMMAND_TOOL_NAME}(${target.argvPattern})`;
                const validation = validateReadableAgentToolRule(rule);
                if (!validation.ok) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: `Invalid run_command access request: ${validation.reason}`,
                            },
                        ],
                    };
                }
                const fallbackValidation = options.validateRunCommandFallback?.({
                    argvPattern: target.argvPattern,
                });
                if (fallbackValidation)
                    return fallbackValidation;
                if (args.temporaryOnly !== true) {
                    const durableValidation = validateDurableAccessRule(rule);
                    if (!durableValidation.ok) {
                        return {
                            isError: true,
                            content: [
                                {
                                    type: 'text',
                                    text: `Invalid durable run_command access request: ${durableValidation.reason}`,
                                },
                            ],
                        };
                    }
                }
                return submitCapabilityReviewTask('request_permission', 'Permission', {
                    permissionKind: 'tool',
                    capabilityRequestSource: 'request_access',
                    toolName: RUN_COMMAND_TOOL_NAME,
                    rule: target.argvPattern,
                    temporaryOnly: args.temporaryOnly ?? false,
                    broadAccess: args.broadAccess,
                    riskClass: args.riskClass,
                    reason: args.reason,
                });
            }
        }
    });
}
async function availableSemanticCapabilities(options) {
    const capabilities = await options.listCapabilities?.();
    if (!capabilities?.length)
        return [];
    return capabilities.filter((capability) => {
        const validation = validateSemanticCapabilityDefinition(capability);
        return validation.ok;
    });
}
function submitExactToolRequest(input) {
    if (input.options.isToolSelected?.(input.toolName)) {
        return {
            isError: true,
            content: [
                {
                    type: 'text',
                    text: [
                        `Tool "${input.toolName}" is already selected for this run.`,
                        input.toolName === 'AgentDelegation'
                            ? 'Use delegate_task when it is mounted. If delegate_task is still missing, the delegated-task executor is unavailable for this run.'
                            : 'Use the available action directly instead of requesting the same access again.',
                    ].join('\n'),
                },
            ],
        };
    }
    return input.submitCapabilityReviewTask('request_permission', 'Permission', {
        permissionKind: 'tool',
        capabilityRequestSource: 'request_access',
        toolName: input.toolName,
        temporaryOnly: input.args.temporaryOnly ?? false,
        broadAccess: input.args.broadAccess,
        riskClass: input.args.riskClass,
        reason: input.args.reason,
    });
}
function normalizeExactRequestableToolName(value) {
    const trimmed = value.trim();
    if (!trimmed || parseReadableScopedToolRule(trimmed))
        return null;
    if (trimmed === 'delegate_task' || trimmed === 'task_message') {
        return 'AgentDelegation';
    }
    if (isAdminMcpToolFullName(trimmed))
        return trimmed;
    if (isAdminMcpToolName(trimmed))
        return adminMcpToolFullName(trimmed);
    if (isGantryFacadeExactToolName(trimmed)) {
        const validation = validateDurableAccessRule(trimmed);
        return validation.ok ? trimmed : null;
    }
    return null;
}
