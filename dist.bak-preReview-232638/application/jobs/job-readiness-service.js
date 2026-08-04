import { ApplicationError } from '../common/application-error.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from './job-access.js';
import { agentIdForJobWorkspaceKey, resolveJobToolPolicy, } from './job-tool-policy.js';
import { evaluateToolAccessRequirements, normalizeToolAccessRequirements, toolAccessRequirementRecoveryAction, } from './job-tool-access-requirements.js';
import { splitAccessRequirements } from './job-access-requirements.js';
import { isCanonicalBrowserCapabilityRule, isProjectedBrowserMcpToolRule, publicGantryToolNameForSdkTool, RUN_COMMAND_TOOL_NAME, } from '../../shared/agent-tool-references.js';
import { parseSemanticCapabilityRule, semanticCapabilityRule, } from '../../shared/semantic-capability-ids.js';
import { semanticCapabilityFromToolCatalogItem, } from '../../shared/semantic-capabilities.js';
import { stableSha256Json } from '../../shared/stable-hash.js';
import { nowIso } from '../../shared/time/datetime.js';
import { capabilityRequirementSetupAction, formatCapabilityRequirement, localCliCommandTemplatePermissionRule, } from './job-capability-requirements.js';
import { CapabilitySecretService } from '../capability-secrets/capability-secret-service.js';
import { formatMissingGantrySecretsMessage, humanizeTechnicalIdentifier, } from '../../shared/user-visible-messages.js';
export const SETUP_REQUIRED_PAUSE_REASON = 'Setup required';
export async function evaluateJobReadiness(input) {
    const appId = input.appId ?? DEFAULT_JOB_RUNTIME_APP_ID;
    const agentId = input.agentId ?? agentIdForJobWorkspaceKey(input.job.workspace_key);
    const blockers = [];
    const invalidWorkspaceBlocker = invalidWorkspaceConfigBlocker(input.job);
    if (invalidWorkspaceBlocker) {
        return blockedSetupResult({
            blocker: invalidWorkspaceBlocker,
            checkedAt: input.clock?.now() ?? nowIso(),
            previous: input.job.setup_state,
        });
    }
    let splitRequirements;
    try {
        splitRequirements = splitAccessRequirements(input.job.access_requirements);
    }
    catch (error) {
        if (error instanceof ApplicationError && error.code === 'INVALID_REQUEST') {
            return blockedSetupResult({
                blocker: malformedRequirementBlocker(error.message),
                checkedAt: input.clock?.now() ?? nowIso(),
                previous: input.job.setup_state,
            });
        }
        throw error;
    }
    const { toolAccessRequirements: jobToolAccessRequirements, capabilityRequirements: jobCapabilityRequirements, requiredMcpServers: jobRequiredMcpServers, } = splitRequirements;
    let policy;
    let policyResolutionError = null;
    try {
        policy = await resolveJobToolPolicy({
            job: input.job,
            appId,
            agentId,
            toolRepository: input.toolRepository,
            skillRepository: input.skillRepository,
        });
    }
    catch (error) {
        if (!(error instanceof ApplicationError) || error.code !== 'FORBIDDEN') {
            throw error;
        }
        policyResolutionError = error.message;
        policy = {
            inheritedTools: [],
            effectiveAllowedTools: [],
            runtimeAccess: [],
        };
        blockers.push(invalidAgentToolPolicyBlocker(error.message));
    }
    const toolPreflight = policyResolutionError
        ? {
            toolAccessRequirements: normalizeToolAccessRequirements(jobToolAccessRequirements),
            missingTools: [],
        }
        : evaluateToolAccessRequirements({
            toolAccessRequirements: jobToolAccessRequirements,
            effectiveAllowedTools: policy.effectiveAllowedTools,
        });
    const draftOnlyRequirementRules = new Set(jobCapabilityRequirements
        .filter((requirement) => requirement.implementation?.kind === 'local_cli')
        .map((requirement) => semanticCapabilityRule(requirement.capabilityId)));
    const localCliRequirementCapabilities = new Set(jobCapabilityRequirements
        .filter((requirement) => requirement.implementation?.kind === 'local_cli')
        .map((requirement) => requirement.capabilityId));
    for (const missingTool of toolPreflight.missingTools) {
        if (draftOnlyRequirementRules.has(missingTool))
            continue;
        const semanticCapabilityId = parseSemanticCapabilityRule(missingTool);
        if (semanticCapabilityId && !semanticCapabilityId.startsWith('skill.')) {
            const capability = await catalogSemanticCapabilityDefinition({
                capabilityId: semanticCapabilityId,
                appId,
                repository: input.toolRepository,
            });
            if (!capability) {
                blockers.push(unreviewedSemanticCapabilityBlocker(semanticCapabilityId));
                continue;
            }
        }
        blockers.push(missingToolBlocker(missingTool));
    }
    for (const requirement of jobCapabilityRequirements) {
        const blocker = capabilityRequirementBlocker({
            requirement,
            effectiveAllowedTools: policy.effectiveAllowedTools,
        });
        if (blocker)
            blockers.push(blocker);
    }
    for (const capabilityId of selectedCapabilityIdsMissingFromImage({
        imageInventory: input.workerImageInventory,
        capabilityRequirements: jobCapabilityRequirements,
        toolAccessRequirements: jobToolAccessRequirements,
        localCliRequirementCapabilities,
    })) {
        blockers.push(imageInventoryMissingBlocker(capabilityId));
    }
    try {
        const missingToolSet = new Set(toolPreflight.missingTools);
        for (const toolAccessRequirement of toolPreflight.toolAccessRequirements) {
            if (missingToolSet.has(toolAccessRequirement))
                continue;
            if (isCanonicalBrowserCapabilityRule(toolAccessRequirement)) {
                continue;
            }
            const semanticCapabilityId = parseSemanticCapabilityRule(toolAccessRequirement);
            if (semanticCapabilityId) {
                if (localCliRequirementCapabilities.has(semanticCapabilityId)) {
                    continue;
                }
                const credentialBlocker = await semanticCapabilityCredentialBlocker({
                    capabilityId: semanticCapabilityId,
                    capability: await catalogSemanticCapabilityDefinition({
                        capabilityId: semanticCapabilityId,
                        appId,
                        repository: input.toolRepository,
                    }),
                    agentId,
                    broker: input.credentialBroker,
                });
                if (credentialBlocker)
                    blockers.push(credentialBlocker);
            }
        }
        blockers.push(...(await mcpReadinessBlockers({
            requiredMcpServers: jobRequiredMcpServers,
            appId,
            agentId,
            repository: input.mcpServerRepository,
            secrets: input.capabilitySecretRepository,
        })));
    }
    catch (error) {
        if (error instanceof ApplicationError && error.code === 'UNAVAILABLE') {
            return blockedSetupResult({
                blocker: brokerUnreachableBlocker(error.message),
                checkedAt: input.clock?.now() ?? nowIso(),
                previous: input.job.setup_state,
            });
        }
        throw error;
    }
    const setupState = buildJobSetupState({
        blockers,
        checkedAt: input.clock?.now() ?? nowIso(),
        previous: input.job.setup_state,
    });
    return {
        ready: setupState.state === 'ready',
        setupState,
        pauseReason: setupState.state === 'ready' ? null : SETUP_REQUIRED_PAUSE_REASON,
    };
}
function invalidWorkspaceConfigBlocker(job) {
    const workspaceKey = typeof job.workspace_key === 'string' ? job.workspace_key.trim() : '';
    if (!workspaceKey) {
        return brokerUnreachableBlocker('Job workspace is not configured. The job cannot resolve its runtime workspace.');
    }
    const executionContext = job.execution_context;
    if (executionContext) {
        const ctxWorkspaceKey = typeof executionContext.workspaceKey === 'string'
            ? executionContext.workspaceKey.trim()
            : '';
        const ctxConversationJid = typeof executionContext.conversationJid === 'string'
            ? executionContext.conversationJid.trim()
            : '';
        if (!ctxWorkspaceKey || !ctxConversationJid) {
            return brokerUnreachableBlocker('Job execution context is invalid. It is missing a workspace key or conversation install.');
        }
    }
    return null;
}
function brokerUnreachableBlocker(message) {
    return {
        state: 'broker_unreachable',
        requirementType: 'tool',
        requirementId: 'job_runtime',
        message,
        nextAction: 'Fix the job configuration or restore the runtime broker, then recheck the job.',
    };
}
function malformedRequirementBlocker(message) {
    return {
        state: 'broker_unreachable',
        requirementType: 'tool',
        requirementId: 'access_requirements',
        message: `Job access requirements are invalid: ${message}`,
        nextAction: 'Update the job to valid access requirements, then recheck the job.',
    };
}
function blockedSetupResult(input) {
    const setupState = buildJobSetupState({
        blockers: [input.blocker],
        checkedAt: input.checkedAt,
        previous: input.previous,
    });
    return {
        ready: false,
        setupState,
        pauseReason: SETUP_REQUIRED_PAUSE_REASON,
    };
}
function capabilityRequirementBlocker(input) {
    const { requirement } = input;
    if (requirement.implementation?.kind !== 'local_cli')
        return null;
    const rule = localCliCommandTemplatePermissionRule(requirement.implementation.commandTemplate, requirement.implementation.executablePath);
    if (!rule) {
        return {
            state: 'missing_capability',
            requirementType: 'local_cli',
            requirementId: requirement.capabilityId,
            message: `${formatCapabilityRequirement(requirement)} has an invalid local CLI job requirement.`,
            nextAction: capabilityRequirementSetupAction(requirement),
        };
    }
    if (!requirement.implementation.executableVersion ||
        !requirement.implementation.executableHash) {
        return {
            state: 'missing_capability',
            requirementType: 'local_cli',
            requirementId: requirement.capabilityId,
            message: `${formatCapabilityRequirement(requirement)} needs pinned executable version and hash before this job can request reviewed local CLI access.`,
            nextAction: capabilityRequirementSetupAction(requirement),
        };
    }
    if (rule &&
        input.effectiveAllowedTools.includes(`${RUN_COMMAND_TOOL_NAME}(${rule})`)) {
        return null;
    }
    return {
        state: 'missing_capability',
        requirementType: 'local_cli',
        requirementId: requirement.capabilityId,
        message: `${formatCapabilityRequirement(requirement)} needs reviewed local CLI access before this job can run on schedule.`,
        nextAction: capabilityRequirementSetupAction(requirement),
    };
}
export function setupStateForDeniedTool(input) {
    const toolName = canonicalSetupToolName(input.toolName);
    return buildJobSetupState({
        checkedAt: input.checkedAt ?? nowIso(),
        previous: input.previous,
        blockers: [
            {
                state: 'missing_capability',
                requirementType: requirementTypeForTool(toolName),
                requirementId: toolName,
                message: `This job needs ${toolRequirementLabel(toolName)} before it can run.`,
                nextAction: input.recoveryAction?.trim() ||
                    toolAccessRequirementRecoveryAction(toolName),
            },
        ],
    });
}
export function setupStateForTransientPermission(input) {
    const toolName = canonicalSetupToolName(input.toolName);
    return buildJobSetupState({
        checkedAt: input.checkedAt ?? nowIso(),
        previous: input.previous,
        blockers: [
            {
                state: 'missing_capability',
                requirementType: requirementTypeForTool(toolName),
                requirementId: toolName,
                message: `This scheduled job used temporary ${toolRequirementLabel(toolName)}. Approve lasting access before future runs continue.`,
                nextAction: input.recoveryAction?.trim() ||
                    toolAccessRequirementRecoveryAction(toolName),
            },
        ],
    });
}
export function setupStateForBrowserPrelaunchFailure(input) {
    return buildJobSetupState({
        checkedAt: input.checkedAt ?? nowIso(),
        previous: input.previous,
        blockers: [
            {
                state: 'browser_login_may_be_required',
                requirementType: 'browser',
                requirementId: 'Browser',
                message: 'Browser could not be launched for this scheduled job before the agent run started.',
                nextAction: 'Run `gantry browser status`, fix the Browser profile if needed, then resume the job.',
            },
        ],
    });
}
function buildJobSetupState(input) {
    const blockers = dedupeBlockers(input.blockers);
    const state = blockers[0]?.state ?? 'ready';
    const fingerprint = stableSha256Json({
        state,
        blockers: blockers.map((blocker) => ({
            state: blocker.state,
            requirementType: blocker.requirementType,
            requirementId: blocker.requirementId,
            nextAction: blocker.nextAction,
        })),
    });
    return {
        state,
        checked_at: input.checkedAt,
        fingerprint,
        blockers,
        notified_fingerprint: input.previous?.fingerprint === fingerprint
            ? input.previous.notified_fingerprint
            : null,
    };
}
function dedupeBlockers(blockers) {
    const out = [];
    const seen = new Set();
    for (const blocker of blockers) {
        const key = [
            blocker.state,
            blocker.requirementType,
            blocker.requirementId,
            blocker.nextAction,
        ].join('\0');
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(blocker);
    }
    return out.sort((left, right) => [left.state, left.requirementType, left.requirementId, left.nextAction]
        .join('\0')
        .localeCompare([
        right.state,
        right.requirementType,
        right.requirementId,
        right.nextAction,
    ].join('\0')));
}
function missingToolBlocker(toolName) {
    return {
        state: 'missing_capability',
        requirementType: requirementTypeForTool(toolName),
        requirementId: toolName,
        message: `Setup required: capability dependency missing: ${toolRequirementLabel(toolName)}.`,
        nextAction: toolAccessRequirementRecoveryAction(toolName),
    };
}
function selectedCapabilityIdsMissingFromImage(input) {
    if (!input.imageInventory)
        return [];
    const inventory = input.imageInventory;
    const inventorySet = new Set(inventory);
    const selectedCapabilityIds = new Set();
    for (const requirement of input.capabilityRequirements) {
        selectedCapabilityIds.add(requirement.capabilityId);
    }
    for (const toolAccessRequirement of input.toolAccessRequirements) {
        const semanticCapabilityId = parseSemanticCapabilityRule(toolAccessRequirement);
        if (semanticCapabilityId)
            selectedCapabilityIds.add(semanticCapabilityId);
    }
    const missing = [];
    for (const capabilityId of selectedCapabilityIds) {
        // Local CLI capabilities are evaluated through their own reviewed-access
        // path, not the image inventory.
        if (input.localCliRequirementCapabilities.has(capabilityId))
            continue;
        if (!inventorySet.has(capabilityId))
            missing.push(capabilityId);
    }
    return missing.sort();
}
function imageInventoryMissingBlocker(capabilityId) {
    return {
        state: 'missing_capability',
        requirementType: 'semantic_capability',
        requirementId: capabilityId,
        message: `Setup required: ${humanizeTechnicalIdentifier(capabilityId)} is selected for this agent but is not available in the worker image.`,
        nextAction: 'Rebuild or deploy a worker image that includes this capability, or deselect it for this agent.',
    };
}
function unreviewedSemanticCapabilityBlocker(capabilityId) {
    return {
        state: 'missing_capability',
        requirementType: 'semantic_capability',
        requirementId: capabilityId,
        message: 'This job references a capability that is not reviewed in the capability catalog.',
        nextAction: 'Refresh attached source inventory, then update the job to a reviewed source-neutral capability (request it with request_access target.kind=capability).',
    };
}
function invalidAgentToolPolicyBlocker(message) {
    return {
        state: 'missing_capability',
        requirementType: 'tool',
        requirementId: 'agent_tool_policy',
        message: `Agent tool policy is invalid: ${message}`,
        nextAction: 'Review the agent selected capabilities, then remove or reapprove the invalid tool binding.',
    };
}
function requirementTypeForTool(toolName) {
    if (isCanonicalBrowserCapabilityRule(toolName))
        return 'browser';
    if (parseSemanticCapabilityRule(toolName))
        return 'semantic_capability';
    return 'tool';
}
function canonicalSetupToolName(toolName) {
    return isProjectedBrowserMcpToolRule(toolName)
        ? 'Browser'
        : publicGantryToolNameForSdkTool(toolName);
}
function toolRequirementLabel(toolName) {
    if (isCanonicalBrowserCapabilityRule(toolName))
        return 'Browser access';
    const semanticCapabilityId = parseSemanticCapabilityRule(toolName);
    if (semanticCapabilityId) {
        return humanizeTechnicalIdentifier(semanticCapabilityId);
    }
    return humanizeTechnicalIdentifier(toolName);
}
async function semanticCapabilityCredentialBlocker(input) {
    const capability = input.capability;
    if (!capability && input.capabilityId.startsWith('skill.'))
        return null;
    if (!capability) {
        return {
            state: 'missing_capability',
            requirementType: 'semantic_capability',
            requirementId: input.capabilityId,
            message: 'Semantic capability is not registered in the capability catalog.',
            nextAction: 'Refresh attached source inventory, then update the job to a reviewed source-neutral capability (request it with request_access target.kind=capability).',
        };
    }
    if (capability.credentialSource === 'local_cli')
        return null;
    if (capability.preflight?.kind === 'broker') {
        return {
            state: 'credential_unknown',
            requirementType: 'credential',
            requirementId: input.capabilityId,
            message: 'Capability account readiness is unknown because no safe non-mutating preflight exists.',
            nextAction: 'Confirm the account connection is ready, then resume or recheck the job.',
        };
    }
    return null;
}
async function catalogSemanticCapabilityDefinition(input) {
    if (!input.repository || typeof input.repository.listTools !== 'function') {
        return undefined;
    }
    const tools = await input.repository.listTools({
        appId: input.appId,
        statuses: ['active'],
    });
    for (const tool of tools) {
        const capability = semanticCapabilityFromToolCatalogItem(tool);
        if (capability?.capabilityId === input.capabilityId)
            return capability;
    }
    return undefined;
}
async function mcpReadinessBlockers(input) {
    const required = input.requiredMcpServers;
    if (required.length === 0)
        return [];
    if (!input.repository) {
        return required.map((requirement) => ({
            state: 'missing_capability',
            requirementType: 'mcp_server',
            requirementId: requirement,
            message: `Required MCP server is not available to verify: ${requirement}.`,
            nextAction: mcpRequestAction(requirement),
        }));
    }
    const blockers = [];
    const materialized = await input.repository.listMaterializedServersForAgent({
        appId: input.appId,
        agentId: input.agentId,
    });
    for (const requirement of required) {
        const record = materialized.find((candidate) => candidate.definition.name === requirement ||
            candidate.definition.id === requirement);
        if (!record) {
            const definition = requirement.startsWith('mcp:')
                ? await input.repository.getServer(requirement)
                : await input.repository.getServerByName({
                    appId: input.appId,
                    name: requirement,
                });
            blockers.push({
                state: 'missing_capability',
                requirementType: 'mcp_server',
                requirementId: requirement,
                message: definition?.status === 'disabled'
                    ? `Required MCP server is disabled: ${requirement}.`
                    : `Required MCP server is not bound to this agent: ${requirement}.`,
                nextAction: mcpRequestAction(requirement),
            });
            continue;
        }
        const credentialRefs = record.definition.credentialRefs;
        if (credentialRefs.length === 0)
            continue;
        if (!input.secrets) {
            blockers.push(mcpCredentialBlocker(record.definition.name, credentialRefs.map((ref) => ref.name)));
            continue;
        }
        const resolved = await new CapabilitySecretService(input.secrets).resolveMcpCredentialRefs({
            appId: input.appId,
            refs: credentialRefs,
            allowedCapabilityIds: [
                record.definition.id,
                `mcp:${record.definition.name}`,
            ],
        });
        if (resolved.missing.length > 0) {
            blockers.push(mcpCredentialBlocker(record.definition.name, resolved.missing));
        }
    }
    return blockers;
}
function mcpCredentialBlocker(serverName, secretNames) {
    return {
        state: 'mcp_missing_credential',
        requirementType: 'mcp_server',
        requirementId: serverName,
        message: formatMissingGantrySecretsMessage(secretNames),
        nextAction: 'Add the required credentials in Credential Center, then resume or recheck the job.',
    };
}
function mcpRequestAction(requirement) {
    return `request_mcp_server ${JSON.stringify({ name: requirement, reason: 'This autonomous run requires this MCP server.' })}`;
}
