import type {
  Job,
  JobCapabilityRequirement,
  JobSetupBlocker,
  JobSetupState,
} from '../../domain/types.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import type { McpServerId } from '../../domain/mcp/mcp-servers.js';
import type { Clock } from '../common/clock.js';
import { ApplicationError } from '../common/application-error.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from './job-access.js';
import {
  agentIdForJobWorkspaceKey,
  resolveJobToolPolicy,
  type JobToolPolicyResolution,
} from './job-tool-policy.js';
import {
  evaluateToolAccessRequirements,
  normalizeToolAccessRequirements,
  toolAccessRequirementRecoveryAction,
} from './job-tool-access-requirements.js';
import { splitAccessRequirements } from './job-access-requirements.js';
import {
  isCanonicalBrowserCapabilityRule,
  isProjectedBrowserMcpToolRule,
  parseReadableScopedToolRule,
  publicGantryToolNameForSdkTool,
  RUN_COMMAND_TOOL_NAME,
} from '../../shared/agent-tool-references.js';
import {
  approveRuleSetupAction,
  compareJobSetupBlockers,
  instructionSetupAction,
  jobSetupActionIdentity,
} from '../../shared/job-setup-action.js';
import {
  parseSemanticCapabilityRule,
  semanticCapabilityRule,
} from '../../shared/semantic-capability-ids.js';
import type { SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';
import { stableSha256Json } from '../../shared/stable-hash.js';
import { nowIso } from '../../shared/time/datetime.js';
import {
  catalogSemanticCapabilityDefinition,
  capabilityRequirementSetupAction,
  formatCapabilityRequirement,
  localCliCommandTemplatePermissionRule,
} from './job-capability-requirements.js';
import { CapabilitySecretService } from '../capability-secrets/capability-secret-service.js';
import {
  formatMissingGantrySecretsMessage,
  humanizeTechnicalIdentifier,
} from '../../shared/user-visible-messages.js';
import {
  assertHostAccessSnapshot,
  type AgentAccessSnapshot,
} from '../agent-execution/agent-access-snapshot.js';
export const SETUP_REQUIRED_PAUSE_REASON = 'Setup required';
export interface JobReadinessBrowserStatus {
  hasState?: boolean;
  authMarkers?: string[];
  error?: string;
}
export interface JobReadinessDeps {
  toolRepository?: ToolCatalogRepository;
  skillRepository?: SkillCatalogRepository;
  mcpServerRepository?: McpServerRepository;
  capabilitySecretRepository?: CapabilitySecretRepository;
  credentialBroker?: AgentCredentialBroker;
  getBrowserStatus?: (
    profileName: string,
  ) => Promise<JobReadinessBrowserStatus | undefined>;
  // Fixed-image worker mode: capabilities baked into the executing worker image.
  // When declared (non-empty), a selected capability that is not in this
  // inventory fails closed as setup_required before the runner starts. An empty
  // or omitted inventory means "no image inventory declared" and is not enforced.
  workerImageInventory?: readonly string[];
  clock?: Clock;
  accessSnapshot?: AgentAccessSnapshot;
}
export interface JobReadinessInput extends JobReadinessDeps {
  job: Pick<
    Job,
    | 'id'
    | 'workspace_key'
    | 'access_requirements'
    | 'execution_context'
    | 'notification_routes'
    | 'setup_state'
  >;
  appId?: string;
  agentId?: string;
}
export interface JobReadinessResult {
  ready: boolean;
  setupState: JobSetupState;
  pauseReason: typeof SETUP_REQUIRED_PAUSE_REASON | null;
}
export async function evaluateJobReadiness(
  input: JobReadinessInput,
): Promise<JobReadinessResult> {
  const appId = input.appId ?? DEFAULT_JOB_RUNTIME_APP_ID;
  const agentId =
    input.agentId ?? agentIdForJobWorkspaceKey(input.job.workspace_key);
  const accessSnapshot = assertHostAccessSnapshot({
    accessSnapshot: input.accessSnapshot,
    appId,
    agentId,
    subject: 'Job readiness',
  });
  const blockers: JobSetupBlocker[] = [];

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
  } catch (error) {
    if (error instanceof ApplicationError && error.code === 'INVALID_REQUEST') {
      return blockedSetupResult({
        blocker: malformedRequirementBlocker(error.message),
        checkedAt: input.clock?.now() ?? nowIso(),
        previous: input.job.setup_state,
      });
    }
    throw error;
  }
  const {
    toolAccessRequirements: jobToolAccessRequirements,
    capabilityRequirements: jobCapabilityRequirements,
    requiredMcpServers: jobRequiredMcpServers,
  } = splitRequirements;

  let policy: JobToolPolicyResolution;
  let policyResolutionError: string | null = null;
  try {
    policy = await resolveJobToolPolicy({
      job: input.job as Job,
      appId,
      agentId,
      toolRepository: input.toolRepository,
      skillRepository: input.skillRepository,
      accessSnapshot,
    });
  } catch (error) {
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
        toolAccessRequirements: normalizeToolAccessRequirements(
          jobToolAccessRequirements,
        ),
        missingTools: [],
      }
    : evaluateToolAccessRequirements({
        toolAccessRequirements: jobToolAccessRequirements,
        effectiveAllowedTools: policy.effectiveAllowedTools,
      });
  const draftOnlyRequirementRules = new Set(
    jobCapabilityRequirements
      .filter((requirement) => requirement.implementation?.kind === 'local_cli')
      .map((requirement) => semanticCapabilityRule(requirement.capabilityId)),
  );
  const localCliRequirementCapabilities = new Set(
    jobCapabilityRequirements
      .filter((requirement) => requirement.implementation?.kind === 'local_cli')
      .map((requirement) => requirement.capabilityId),
  );
  for (const missingTool of toolPreflight.missingTools) {
    if (draftOnlyRequirementRules.has(missingTool)) continue;
    const semanticCapabilityId = parseSemanticCapabilityRule(missingTool);
    if (semanticCapabilityId && !semanticCapabilityId.startsWith('skill.')) {
      const capability = await catalogSemanticCapabilityDefinition({
        capabilityId: semanticCapabilityId,
        appId,
        repository: input.toolRepository,
        accessSnapshot,
      });
      if (!capability) {
        blockers.push(
          unreviewedSemanticCapabilityBlocker(semanticCapabilityId),
        );
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
    if (blocker) blockers.push(blocker);
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
      if (missingToolSet.has(toolAccessRequirement)) continue;
      if (isCanonicalBrowserCapabilityRule(toolAccessRequirement)) {
        continue;
      }
      const semanticCapabilityId = parseSemanticCapabilityRule(
        toolAccessRequirement,
      );
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
            accessSnapshot,
          }),
          agentId,
          broker: input.credentialBroker,
        });
        if (credentialBlocker) blockers.push(credentialBlocker);
      }
    }

    blockers.push(
      ...(await mcpReadinessBlockers({
        requiredMcpServers: jobRequiredMcpServers,
        appId,
        agentId,
        repository: input.mcpServerRepository,
        secrets: input.capabilitySecretRepository,
        accessSnapshot,
      })),
    );
  } catch (error) {
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
    pauseReason:
      setupState.state === 'ready' ? null : SETUP_REQUIRED_PAUSE_REASON,
  };
}
function invalidWorkspaceConfigBlocker(
  job: JobReadinessInput['job'],
): JobSetupBlocker | null {
  const workspaceKey =
    typeof job.workspace_key === 'string' ? job.workspace_key.trim() : '';
  if (!workspaceKey) {
    return brokerUnreachableBlocker(
      'Job workspace is not configured. The job cannot resolve its runtime workspace.',
    );
  }
  const executionContext = job.execution_context as
    | { workspaceKey?: unknown; conversationJid?: unknown }
    | null
    | undefined;
  if (executionContext) {
    const ctxWorkspaceKey =
      typeof executionContext.workspaceKey === 'string'
        ? executionContext.workspaceKey.trim()
        : '';
    const ctxConversationJid =
      typeof executionContext.conversationJid === 'string'
        ? executionContext.conversationJid.trim()
        : '';
    if (!ctxWorkspaceKey || !ctxConversationJid) {
      return brokerUnreachableBlocker(
        'Job execution context is invalid. It is missing a workspace key or conversation install.',
      );
    }
  }
  return null;
}
function brokerUnreachableBlocker(message: string): JobSetupBlocker {
  return {
    state: 'broker_unreachable',
    type: 'tool',
    id: 'job_runtime',
    summary: message,
    action: instructionSetupAction(
      'Fix the job configuration or restore the runtime broker, then recheck the job.',
    ),
  };
}

function malformedRequirementBlocker(message: string): JobSetupBlocker {
  return {
    state: 'broker_unreachable',
    type: 'tool',
    id: 'access_requirements',
    summary: `Job access requirements are invalid: ${message}`,
    action: instructionSetupAction(
      'Update the job to valid access requirements, then recheck the job.',
    ),
  };
}

function blockedSetupResult(input: {
  blocker: JobSetupBlocker;
  checkedAt: string;
  previous?: JobSetupState;
}): JobReadinessResult {
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

function capabilityRequirementBlocker(input: {
  requirement: JobCapabilityRequirement;
  effectiveAllowedTools: readonly string[];
}): JobSetupBlocker | null {
  const { requirement } = input;
  if (requirement.implementation?.kind !== 'local_cli') return null;
  const rule = localCliCommandTemplatePermissionRule(
    requirement.implementation.commandTemplate,
    requirement.implementation.executablePath,
  );
  if (!rule) {
    return {
      state: 'missing_capability',
      type: 'local_cli',
      id: requirement.capabilityId,
      summary: `${formatCapabilityRequirement(requirement)} has an invalid local CLI job requirement.`,
      action: instructionSetupAction(
        capabilityRequirementSetupAction(requirement),
      ),
    };
  }
  if (
    !requirement.implementation.executableVersion ||
    !requirement.implementation.executableHash
  ) {
    return {
      state: 'missing_capability',
      type: 'local_cli',
      id: requirement.capabilityId,
      summary: `${formatCapabilityRequirement(requirement)} needs pinned executable version and hash before this job can request reviewed local CLI access.`,
      action: instructionSetupAction(
        capabilityRequirementSetupAction(requirement),
      ),
    };
  }
  if (
    rule &&
    input.effectiveAllowedTools.includes(`${RUN_COMMAND_TOOL_NAME}(${rule})`)
  ) {
    return null;
  }
  return {
    state: 'missing_capability',
    type: 'local_cli',
    id: requirement.capabilityId,
    summary: `${formatCapabilityRequirement(requirement)} needs reviewed local CLI access before this job can run on schedule.`,
    action: approveRuleSetupAction(`${RUN_COMMAND_TOOL_NAME}(${rule})`),
  };
}

export function setupStateForDeniedTool(input: {
  toolName: string;
  action: JobSetupBlocker['action'];
  checkedAt?: string;
  previous?: JobSetupState;
}): JobSetupState {
  const toolName = canonicalSetupToolName(input.toolName);
  return buildJobSetupState({
    checkedAt: input.checkedAt ?? nowIso(),
    previous: input.previous,
    blockers: [
      {
        state: 'missing_capability',
        type: requirementTypeForTool(toolName),
        id: toolName,
        summary: `This job needs ${toolRequirementLabel(toolName)} before it can run.`,
        action: input.action,
      },
    ],
  });
}

export function setupStateForTransientPermission(input: {
  toolName: string;
  mode?: string | null;
  recoveryAction?: string | null;
  checkedAt?: string;
  previous?: JobSetupState;
}): JobSetupState {
  const toolName = canonicalSetupToolName(input.toolName);
  return buildJobSetupState({
    checkedAt: input.checkedAt ?? nowIso(),
    previous: input.previous,
    blockers: [
      {
        state: 'missing_capability',
        type: requirementTypeForTool(toolName),
        id: toolName,
        summary: `This scheduled job used temporary ${toolRequirementLabel(toolName)}. Approve lasting access before future runs continue.`,
        // R9: a transient allow pauses with the TYPED one-tap grant whenever
        // the durable rule is derivable from the tool identity alone (scoped
        // rules parse; exact tools stand as-is). Only a bare command tool -
        // where any durable rule would be too broad - falls to a
        // plain-language instruction (never the raw recovery protocol text).
        action: transientPermissionSetupAction(toolName),
      },
    ],
  });
}

function transientPermissionSetupAction(toolName: string) {
  const scoped = parseReadableScopedToolRule(toolName);
  const bareCommandTool =
    (scoped?.toolName ?? toolName) === RUN_COMMAND_TOOL_NAME && !scoped?.scope;
  if (bareCommandTool || toolName === 'Bash') {
    return instructionSetupAction(
      'This job used temporary command access. Approve a scoped command grant from its approval card, then resume the job.',
    );
  }
  return approveRuleSetupAction(toolName);
}

export function setupStateForBrowserPrelaunchFailure(input: {
  checkedAt?: string;
  previous?: JobSetupState;
}): JobSetupState {
  return buildJobSetupState({
    checkedAt: input.checkedAt ?? nowIso(),
    previous: input.previous,
    blockers: [
      {
        state: 'browser_login_may_be_required',
        type: 'browser',
        id: 'Browser',
        summary:
          'Browser could not be launched for this scheduled job before the agent run started.',
        action: instructionSetupAction(
          'Run `gantry browser status`, fix the Browser profile if needed, then resume the job.',
        ),
      },
    ],
  });
}

function buildJobSetupState(input: {
  blockers: readonly JobSetupBlocker[];
  checkedAt: string;
  previous?: JobSetupState;
}): JobSetupState {
  const blockers = dedupeBlockers(input.blockers);
  const state = blockers[0]?.state ?? 'ready';
  const fingerprint = stableSha256Json({
    state,
    blockers: blockers.map(({ summary: _summary, ...blocker }) => blocker),
  });
  return {
    state,
    checked_at: input.checkedAt,
    fingerprint,
    blockers,
    notified_fingerprint:
      input.previous?.fingerprint === fingerprint
        ? input.previous.notified_fingerprint
        : null,
  };
}

function dedupeBlockers(
  blockers: readonly JobSetupBlocker[],
): JobSetupBlocker[] {
  const out: JobSetupBlocker[] = [];
  const seen = new Set<string>();
  for (const blocker of blockers) {
    const key = jobSetupActionIdentity(blocker.action);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(blocker);
  }
  return out.sort(compareJobSetupBlockers);
}

function missingToolBlocker(toolName: string): JobSetupBlocker {
  return {
    state: 'missing_capability',
    type: requirementTypeForTool(toolName),
    id: toolName,
    summary: `Setup required: capability dependency missing: ${toolRequirementLabel(toolName)}.`,
    action: approveRuleSetupAction(toolName),
  };
}

function selectedCapabilityIdsMissingFromImage(input: {
  imageInventory?: readonly string[];
  capabilityRequirements: readonly JobCapabilityRequirement[];
  toolAccessRequirements: readonly string[];
  localCliRequirementCapabilities: ReadonlySet<string>;
}): string[] {
  if (!input.imageInventory) return [];
  const inventory = input.imageInventory;
  const inventorySet = new Set(inventory);
  const selectedCapabilityIds = new Set<string>();
  for (const requirement of input.capabilityRequirements) {
    selectedCapabilityIds.add(requirement.capabilityId);
  }
  for (const toolAccessRequirement of input.toolAccessRequirements) {
    const semanticCapabilityId = parseSemanticCapabilityRule(
      toolAccessRequirement,
    );
    if (semanticCapabilityId) selectedCapabilityIds.add(semanticCapabilityId);
  }
  const missing: string[] = [];
  for (const capabilityId of selectedCapabilityIds) {
    // Local CLI capabilities are evaluated through their own reviewed-access
    // path, not the image inventory.
    if (input.localCliRequirementCapabilities.has(capabilityId)) continue;
    if (!inventorySet.has(capabilityId)) missing.push(capabilityId);
  }
  return missing.sort();
}

function imageInventoryMissingBlocker(capabilityId: string): JobSetupBlocker {
  return {
    state: 'missing_capability',
    type: 'semantic_capability',
    id: capabilityId,
    summary: `Setup required: ${humanizeTechnicalIdentifier(capabilityId)} is selected for this agent but is not available in the worker image.`,
    action: instructionSetupAction(
      'Rebuild or deploy a worker image that includes this capability, or deselect it for this agent.',
    ),
  };
}

function unreviewedSemanticCapabilityBlocker(
  capabilityId: string,
): JobSetupBlocker {
  return {
    state: 'missing_capability',
    type: 'semantic_capability',
    id: capabilityId,
    summary:
      'This job references a capability that is not reviewed in the capability catalog.',
    action: instructionSetupAction(
      'Refresh attached source inventory, then update the job to a reviewed source-neutral capability (request it with request_access target.kind=capability).',
    ),
  };
}

function invalidAgentToolPolicyBlocker(message: string): JobSetupBlocker {
  return {
    state: 'missing_capability',
    type: 'tool',
    id: 'agent_tool_policy',
    summary: `Agent tool policy is invalid: ${message}`,
    action: instructionSetupAction(
      'Review the agent selected capabilities, then remove or reapprove the invalid tool binding.',
    ),
  };
}

function requirementTypeForTool(toolName: string): JobSetupBlocker['type'] {
  if (isCanonicalBrowserCapabilityRule(toolName)) return 'browser';
  if (parseSemanticCapabilityRule(toolName)) return 'semantic_capability';
  return 'tool';
}

function canonicalSetupToolName(toolName: string): string {
  return isProjectedBrowserMcpToolRule(toolName)
    ? 'Browser'
    : publicGantryToolNameForSdkTool(toolName);
}

function toolRequirementLabel(toolName: string): string {
  if (isCanonicalBrowserCapabilityRule(toolName)) return 'Browser access';
  const semanticCapabilityId = parseSemanticCapabilityRule(toolName);
  if (semanticCapabilityId) {
    return humanizeTechnicalIdentifier(semanticCapabilityId);
  }
  return humanizeTechnicalIdentifier(toolName);
}

async function semanticCapabilityCredentialBlocker(input: {
  capabilityId: string;
  capability?: SemanticCapabilityDefinition;
  agentId: string;
  broker?: AgentCredentialBroker;
}): Promise<JobSetupBlocker | null> {
  const capability = input.capability;
  if (!capability && input.capabilityId.startsWith('skill.')) return null;
  if (!capability) {
    return {
      state: 'missing_capability',
      type: 'semantic_capability',
      id: input.capabilityId,
      summary:
        'Semantic capability is not registered in the capability catalog.',
      action: instructionSetupAction(
        'Refresh attached source inventory, then update the job to a reviewed source-neutral capability (request it with request_access target.kind=capability).',
      ),
    };
  }
  if (capability.credentialSource === 'local_cli') return null;
  if (capability.preflight?.kind === 'broker') {
    return {
      state: 'credential_unknown',
      type: 'credential',
      id: input.capabilityId,
      summary:
        'Capability account readiness is unknown because no safe non-mutating preflight exists.',
      action: instructionSetupAction(
        'Confirm the account connection is ready, then resume or recheck the job.',
      ),
    };
  }
  return null;
}

async function mcpReadinessBlockers(input: {
  requiredMcpServers: readonly string[];
  appId: string;
  agentId: string;
  repository?: McpServerRepository;
  secrets?: CapabilitySecretRepository;
  accessSnapshot?: AgentAccessSnapshot;
}): Promise<JobSetupBlocker[]> {
  const required = input.requiredMcpServers;
  if (required.length === 0) return [];
  if (!input.repository && !input.accessSnapshot) {
    return required.map((requirement) => ({
      state: 'missing_capability',
      type: 'mcp_server',
      id: requirement,
      summary: `Required MCP server is not available to verify: ${requirement}.`,
      action: instructionSetupAction(mcpRequestAction(requirement)),
    }));
  }
  const blockers: JobSetupBlocker[] = [];
  const materialized = input.accessSnapshot
    ? input.accessSnapshot.mcp.materializedServers
    : await input.repository!.listMaterializedServersForAgent({
        appId: input.appId as never,
        agentId: input.agentId as never,
      });
  for (const requirement of required) {
    const record = materialized.find(
      (candidate) =>
        candidate.definition.name === requirement ||
        candidate.definition.id === requirement,
    );
    if (!record) {
      const definition = input.repository
        ? requirement.startsWith('mcp:')
          ? await input.repository.getServer(requirement as McpServerId)
          : await input.repository.getServerByName({
              appId: input.appId as never,
              name: requirement,
            })
        : null;
      blockers.push({
        state: 'missing_capability',
        type: 'mcp_server',
        id: requirement,
        summary:
          definition?.status === 'disabled'
            ? `Required MCP server is disabled: ${requirement}.`
            : `Required MCP server is not bound to this agent: ${requirement}.`,
        action: instructionSetupAction(mcpRequestAction(requirement)),
      });
      continue;
    }
    const credentialRefs = record.definition.credentialRefs;
    if (credentialRefs.length === 0) continue;
    if (!input.secrets) {
      blockers.push(
        mcpCredentialBlocker(
          record.definition.name,
          credentialRefs.map((ref) => ref.name),
        ),
      );
      continue;
    }
    const resolved = await new CapabilitySecretService(
      input.secrets,
    ).resolveMcpCredentialRefs({
      appId: input.appId as never,
      refs: credentialRefs,
      allowedCapabilityIds: [
        record.definition.id,
        `mcp:${record.definition.name}`,
      ],
    });
    if (resolved.missing.length > 0) {
      blockers.push(
        mcpCredentialBlocker(record.definition.name, resolved.missing),
      );
    }
  }
  return blockers;
}

function mcpCredentialBlocker(
  serverName: string,
  secretNames: string[],
): JobSetupBlocker {
  return {
    state: 'mcp_missing_credential',
    type: 'mcp_server',
    id: serverName,
    summary: formatMissingGantrySecretsMessage(secretNames),
    action: instructionSetupAction(
      'Add the required credentials in Credential Center, then resume or recheck the job.',
    ),
  };
}

function mcpRequestAction(requirement: string): string {
  return `request_mcp_server ${JSON.stringify({ name: requirement, reason: 'This autonomous run requires this MCP server.' })}`;
}
