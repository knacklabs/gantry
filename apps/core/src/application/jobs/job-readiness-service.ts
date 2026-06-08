import type {
  Job,
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
  agentIdForJobGroupScope,
  resolveJobToolPolicy,
  type JobToolPolicyResolution,
} from './job-tool-policy.js';
import {
  evaluateToolAccessRequirements,
  normalizeToolAccessRequirements,
  toolAccessRequirementRecoveryAction,
} from './job-tool-access-requirements.js';
import {
  isCanonicalBrowserCapabilityRule,
  isProjectedBrowserMcpToolRule,
  publicGantryToolNameForSdkTool,
  RUN_COMMAND_TOOL_NAME,
} from '../../shared/agent-tool-references.js';
import {
  parseSemanticCapabilityRule,
  semanticCapabilityRule,
} from '../../shared/semantic-capability-ids.js';
import {
  semanticCapabilityFromToolCatalogItem,
  type SemanticCapabilityDefinition,
} from '../../shared/semantic-capabilities.js';
import { stableSha256Json } from '../../shared/stable-hash.js';
import { nowIso } from '../../shared/time/datetime.js';
import {
  capabilityRequirementSetupAction,
  formatCapabilityRequirement,
  localCliCommandTemplatePermissionRule,
} from './job-capability-requirements.js';
import { CapabilitySecretService } from '../capability-secrets/capability-secret-service.js';
import {
  formatMissingGantrySecretsMessage,
  humanizeTechnicalIdentifier,
} from '../../shared/user-visible-messages.js';

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
  clock?: Clock;
}

export interface JobReadinessInput extends JobReadinessDeps {
  job: Pick<
    Job,
    | 'id'
    | 'group_scope'
    | 'tool_access_requirements'
    | 'required_mcp_servers'
    | 'capability_requirements'
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
    input.agentId ?? agentIdForJobGroupScope(input.job.group_scope);
  const blockers: JobSetupBlocker[] = [];

  let policy: JobToolPolicyResolution;
  let policyResolutionError: string | null = null;
  try {
    policy = await resolveJobToolPolicy({
      job: input.job as Job,
      appId,
      agentId,
      toolRepository: input.toolRepository,
      skillRepository: input.skillRepository,
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
          input.job.tool_access_requirements ?? [],
        ),
        missingTools: [],
      }
    : evaluateToolAccessRequirements({
        toolAccessRequirements: input.job.tool_access_requirements,
        effectiveAllowedTools: policy.effectiveAllowedTools,
      });
  const draftOnlyRequirementRules = new Set(
    (input.job.capability_requirements ?? [])
      .filter((requirement) => requirement.implementation?.kind === 'local_cli')
      .map((requirement) => semanticCapabilityRule(requirement.capabilityId)),
  );
  const localCliRequirementCapabilities = new Set(
    (input.job.capability_requirements ?? [])
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
  for (const requirement of input.job.capability_requirements ?? []) {
    const blocker = capabilityRequirementBlocker({
      requirement,
      effectiveAllowedTools: policy.effectiveAllowedTools,
    });
    if (blocker) blockers.push(blocker);
  }

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
        }),
        agentId,
        broker: input.credentialBroker,
      });
      if (credentialBlocker) blockers.push(credentialBlocker);
    }
  }

  blockers.push(
    ...(await mcpReadinessBlockers({
      job: input.job,
      appId,
      agentId,
      repository: input.mcpServerRepository,
      secrets: input.capabilitySecretRepository,
    })),
  );

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

function capabilityRequirementBlocker(input: {
  requirement: NonNullable<Job['capability_requirements']>[number];
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
      requirementType: 'local_cli',
      requirementId: requirement.capabilityId,
      message: `${formatCapabilityRequirement(requirement)} has an invalid local CLI job requirement.`,
      nextAction: capabilityRequirementSetupAction(requirement),
    };
  }
  if (
    !requirement.implementation.executableVersion ||
    !requirement.implementation.executableHash
  ) {
    return {
      state: 'missing_capability',
      requirementType: 'local_cli',
      requirementId: requirement.capabilityId,
      message: `${formatCapabilityRequirement(requirement)} needs pinned executable version and hash before this job can request reviewed local CLI access.`,
      nextAction: capabilityRequirementSetupAction(requirement),
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
    requirementType: 'local_cli',
    requirementId: requirement.capabilityId,
    message: `${formatCapabilityRequirement(requirement)} needs reviewed local CLI access before this job can run on schedule.`,
    nextAction: capabilityRequirementSetupAction(requirement),
  };
}

export function setupStateForDeniedTool(input: {
  toolName: string;
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
        requirementType: requirementTypeForTool(toolName),
        requirementId: toolName,
        message: `This job needs ${toolRequirementLabel(toolName)} before it can run.`,
        nextAction:
          input.recoveryAction?.trim() ||
          toolAccessRequirementRecoveryAction(toolName),
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
        requirementType: requirementTypeForTool(toolName),
        requirementId: toolName,
        message: `This scheduled job used temporary ${toolRequirementLabel(toolName)}. Approve lasting access before future runs continue.`,
        nextAction:
          input.recoveryAction?.trim() ||
          toolAccessRequirementRecoveryAction(toolName),
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
    const key = [
      blocker.state,
      blocker.requirementType,
      blocker.requirementId,
      blocker.nextAction,
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(blocker);
  }
  return out.sort((left, right) =>
    [left.state, left.requirementType, left.requirementId, left.nextAction]
      .join('\0')
      .localeCompare(
        [
          right.state,
          right.requirementType,
          right.requirementId,
          right.nextAction,
        ].join('\0'),
      ),
  );
}

function missingToolBlocker(toolName: string): JobSetupBlocker {
  return {
    state: 'missing_capability',
    requirementType: requirementTypeForTool(toolName),
    requirementId: toolName,
    message: `This job needs ${toolRequirementLabel(toolName)} before it can run.`,
    nextAction: toolAccessRequirementRecoveryAction(toolName),
  };
}

function unreviewedSemanticCapabilityBlocker(
  capabilityId: string,
): JobSetupBlocker {
  return {
    state: 'missing_capability',
    requirementType: 'semantic_capability',
    requirementId: capabilityId,
    message:
      'This job references a capability that is not reviewed in the capability catalog.',
    nextAction:
      'Refresh attached source inventory, then update the job to a reviewed source-neutral capability from capability_search.',
  };
}

function invalidAgentToolPolicyBlocker(message: string): JobSetupBlocker {
  return {
    state: 'missing_capability',
    requirementType: 'tool',
    requirementId: 'agent_tool_policy',
    message: `Agent tool policy is invalid: ${message}`,
    nextAction:
      'Review the agent selected capabilities, then remove or reapprove the invalid tool binding.',
  };
}

function requirementTypeForTool(
  toolName: string,
): JobSetupBlocker['requirementType'] {
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
      requirementType: 'semantic_capability',
      requirementId: input.capabilityId,
      message:
        'Semantic capability is not registered in the capability catalog.',
      nextAction:
        'Refresh attached source inventory, then update the job to a reviewed source-neutral capability from capability_search.',
    };
  }
  if (capability.credentialSource === 'local_cli') return null;
  if (capability.preflight?.kind === 'broker') {
    return {
      state: 'credential_unknown',
      requirementType: 'credential',
      requirementId: input.capabilityId,
      message:
        'Capability account readiness is unknown because no safe non-mutating preflight exists.',
      nextAction:
        'Confirm the account connection is ready, then resume or recheck the job.',
    };
  }
  return null;
}

async function catalogSemanticCapabilityDefinition(input: {
  capabilityId: string;
  appId: string;
  repository?: ToolCatalogRepository;
}): Promise<SemanticCapabilityDefinition | undefined> {
  if (!input.repository || typeof input.repository.listTools !== 'function') {
    return undefined;
  }
  const tools = await input.repository.listTools({
    appId: input.appId as never,
    statuses: ['active'],
  });
  for (const tool of tools) {
    const capability = semanticCapabilityFromToolCatalogItem(tool);
    if (capability?.capabilityId === input.capabilityId) return capability;
  }
  return undefined;
}

async function mcpReadinessBlockers(input: {
  job: JobReadinessInput['job'];
  appId: string;
  agentId: string;
  repository?: McpServerRepository;
  secrets?: CapabilitySecretRepository;
}): Promise<JobSetupBlocker[]> {
  const required = input.job.required_mcp_servers ?? [];
  if (required.length === 0) return [];
  if (!input.repository) {
    return required.map((requirement) => ({
      state: 'missing_capability',
      requirementType: 'mcp_server',
      requirementId: requirement,
      message: `Required MCP server is not available to verify: ${requirement}.`,
      nextAction: mcpRequestAction(requirement),
    }));
  }
  const blockers: JobSetupBlocker[] = [];
  const materialized = await input.repository.listMaterializedServersForAgent({
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
      const definition = requirement.startsWith('mcp:')
        ? await input.repository.getServer(requirement as McpServerId)
        : await input.repository.getServerByName({
            appId: input.appId as never,
            name: requirement,
          });
      blockers.push({
        state: 'missing_capability',
        requirementType: 'mcp_server',
        requirementId: requirement,
        message:
          definition?.status === 'disabled'
            ? `Required MCP server is disabled: ${requirement}.`
            : `Required MCP server is not bound to this agent: ${requirement}.`,
        nextAction: mcpRequestAction(requirement),
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
    requirementType: 'mcp_server',
    requirementId: serverName,
    message: formatMissingGantrySecretsMessage(secretNames),
    nextAction: `Set ${secretNames.map((name) => `gantry credentials capability set ${name}`).join(' and ')}, then resume or recheck the job.`,
  };
}

function mcpRequestAction(requirement: string): string {
  return `request_mcp_server ${JSON.stringify({
    name: requirement,
    reason: 'This autonomous run requires this MCP server.',
  })}`;
}
