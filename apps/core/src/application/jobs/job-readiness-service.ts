import type {
  Job,
  JobSetupBlocker,
  JobSetupState,
} from '../../domain/types.js';
import type {
  McpServerRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import type { AgentCredentialBrokerBinding } from '../../domain/models/credentials.js';
import type { McpServerId } from '../../domain/mcp/mcp-servers.js';
import type { Clock } from '../common/clock.js';
import { ApplicationError } from '../common/application-error.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from './job-access.js';
import {
  agentIdForJobGroupScope,
  resolveJobToolPolicy,
} from './job-tool-policy.js';
import {
  evaluateRequiredTools,
  requiredToolRecoveryAction,
} from './job-required-tools.js';
import {
  isCanonicalBrowserCapabilityRule,
  isProjectedBrowserMcpToolRule,
} from '../../shared/agent-tool-references.js';
import {
  parseSemanticCapabilityRule,
  semanticCapabilityRule,
} from '../../shared/semantic-capability-ids.js';
import { getBuiltinSemanticCapability } from '../../shared/semantic-capabilities.js';
import { resolveConversationBrowserProfile } from '../../shared/browser-profile-scope.js';
import { stableSha256Json } from '../../shared/stable-hash.js';
import { nowIso } from '../../shared/time/datetime.js';
import {
  capabilityRequirementSetupAction,
  formatCapabilityRequirement,
  localCliCommandTemplatePermissionRule,
} from './job-capability-requirements.js';

export const SETUP_REQUIRED_PAUSE_REASON = 'Setup required';

export interface JobReadinessBrowserStatus {
  hasState?: boolean;
  authMarkers?: string[];
  error?: string;
}

export interface JobReadinessDeps {
  toolRepository?: ToolCatalogRepository;
  mcpServerRepository?: McpServerRepository;
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
    | 'required_tools'
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

  const policy = await resolveJobToolPolicy({
    job: input.job as Job,
    appId,
    agentId,
    toolRepository: input.toolRepository,
  });
  const toolPreflight = evaluateRequiredTools({
    requiredTools: input.job.required_tools,
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
  for (const requiredTool of toolPreflight.requiredTools) {
    if (missingToolSet.has(requiredTool)) continue;
    if (isCanonicalBrowserCapabilityRule(requiredTool)) {
      const browserBlocker = await browserReadinessBlocker(input);
      if (browserBlocker) blockers.push(browserBlocker);
      continue;
    }
    const semanticCapabilityId = parseSemanticCapabilityRule(requiredTool);
    if (semanticCapabilityId) {
      if (localCliRequirementCapabilities.has(semanticCapabilityId)) {
        continue;
      }
      const credentialBlocker = await semanticCapabilityCredentialBlocker({
        capabilityId: semanticCapabilityId,
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
      broker: input.credentialBroker,
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
  if (rule && input.effectiveAllowedTools.includes(`Bash(${rule})`)) {
    return null;
  }
  return {
    state: 'draft_only',
    requirementType: 'local_cli',
    requirementId: requirement.capabilityId,
    message: `${formatCapabilityRequirement(requirement)} needs reviewed local CLI access before this job can run autonomously.`,
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
        message: `Autonomous run denied required tool ${toolName}.`,
        nextAction:
          input.recoveryAction?.trim() || requiredToolRecoveryAction(toolName),
      },
    ],
  });
}

export function setupStateForTransientPermission(input: {
  toolName: string;
  mode?: string | null;
  checkedAt?: string;
  previous?: JobSetupState;
}): JobSetupState {
  const mode = input.mode?.trim() || 'transient approval';
  const toolName = canonicalSetupToolName(input.toolName);
  return buildJobSetupState({
    checkedAt: input.checkedAt ?? nowIso(),
    previous: input.previous,
    blockers: [
      {
        state: 'missing_capability',
        requirementType: requirementTypeForTool(toolName),
        requirementId: toolName,
        message: `Recurring autonomous job used ${mode} for ${toolName}.`,
        nextAction: requiredToolRecoveryAction(toolName),
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
    message: `Required tool is not durably approved for this job: ${toolName}.`,
    nextAction: requiredToolRecoveryAction(toolName),
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
  return isProjectedBrowserMcpToolRule(toolName) ? 'Browser' : toolName;
}

async function browserReadinessBlocker(
  input: JobReadinessInput,
): Promise<JobSetupBlocker | null> {
  const executionContext = input.job.execution_context;
  const profileGroupScope = browserProfileGroupScope(input);
  const profileName = resolveConversationBrowserProfile({
    agentId: profileGroupScope,
    workspaceKey: profileGroupScope,
    conversationId:
      executionContext?.conversationJid ??
      input.job.notification_routes?.[0]?.conversationJid ??
      input.job.group_scope,
  });
  let status: JobReadinessBrowserStatus | undefined;
  try {
    status = await input.getBrowserStatus?.(profileName);
  } catch {
    status = undefined;
  }
  const hasLoginSignal =
    status?.hasState === true || (status?.authMarkers?.length ?? 0) > 0;
  if (hasLoginSignal) return null;
  return {
    state: 'browser_login_may_be_required',
    requirementType: 'browser',
    requirementId: 'Browser',
    message:
      'Browser is approved, but this profile has no durable login signal yet.',
    nextAction: `Open Browser profile ${profileName}, sign in if needed, then resume or recheck the job.`,
  };
}

function browserProfileGroupScope(input: JobReadinessInput): string {
  const executionGroupScope = input.job.execution_context?.groupScope?.trim();
  const jobGroupScope = input.job.group_scope.trim();
  return (executionGroupScope || jobGroupScope).replace(/^agent:/, '');
}

async function semanticCapabilityCredentialBlocker(input: {
  capabilityId: string;
  agentId: string;
  broker?: AgentCredentialBroker;
}): Promise<JobSetupBlocker | null> {
  const capability = getBuiltinSemanticCapability(input.capabilityId);
  if (!capability) {
    return {
      state: 'missing_capability',
      requirementType: 'semantic_capability',
      requirementId: input.capabilityId,
      message:
        'Semantic capability is not registered in the capability catalog.',
      nextAction:
        'Search for an available capability or request a reviewed capability, then resume or recheck the job.',
    };
  }
  if (capability.credentialSource === 'local_cli') {
    return {
      state: 'draft_only',
      requirementType: 'local_cli',
      requirementId: input.capabilityId,
      message:
        'Local CLI semantic capabilities are reviewable drafts until runtime enforcement verifies the executable.',
      nextAction:
        'Complete local CLI capability review and durable binding, then resume or recheck the job.',
    };
  }
  if (
    capability.credentialSource !== 'onecli' &&
    capability.credentialSource !== 'external_broker' &&
    !semanticCapabilityNeedsBroker(capability)
  ) {
    return null;
  }
  if (!input.broker) {
    return {
      state: 'broker_unreachable',
      requirementType: 'credential',
      requirementId: input.capabilityId,
      message: 'Credential broker is not available for this capability.',
      nextAction:
        'Connect or refresh the credential broker account, then resume or recheck the job.',
    };
  }
  const binding = brokerBinding(input.broker, input.agentId);
  try {
    const health = await input.broker.healthCheck({ binding });
    if (health.status === 'fail') {
      return {
        state: 'broker_unreachable',
        requirementType: 'credential',
        requirementId: input.capabilityId,
        message: 'Credential broker health check is failing.',
        nextAction:
          health.nextAction ||
          'Connect or refresh the credential broker account, then resume or recheck the job.',
      };
    }
    if (health.status === 'warn') {
      return {
        state: 'credential_unknown',
        requirementType: 'credential',
        requirementId: input.capabilityId,
        message: 'Credential broker could not prove this account is ready.',
        nextAction:
          health.nextAction ||
          'Refresh the account connection, then resume or recheck the job.',
      };
    }
  } catch {
    return {
      state: 'broker_unreachable',
      requirementType: 'credential',
      requirementId: input.capabilityId,
      message: 'Credential broker health check could not complete.',
      nextAction:
        'Connect or refresh the credential broker account, then resume or recheck the job.',
    };
  }
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

function semanticCapabilityNeedsBroker(
  capability: NonNullable<ReturnType<typeof getBuiltinSemanticCapability>>,
): boolean {
  return capability.implementationBindings.some((binding) =>
    binding.rule?.startsWith('Bash(onecli '),
  );
}

async function mcpReadinessBlockers(input: {
  job: JobReadinessInput['job'];
  appId: string;
  agentId: string;
  repository?: McpServerRepository;
  broker?: AgentCredentialBroker;
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
        state:
          definition?.status === 'draft' ? 'draft_only' : 'missing_capability',
        requirementType: 'mcp_server',
        requirementId: requirement,
        message:
          definition?.status === 'draft'
            ? `Required MCP server is still a draft: ${requirement}.`
            : `Required MCP server is not bound to this agent: ${requirement}.`,
        nextAction:
          definition?.status === 'draft'
            ? 'Approve and bind the MCP server, then resume or recheck the job.'
            : mcpRequestAction(requirement),
      });
      continue;
    }
    const credentialRefs = record.version.credentialRefs;
    if (credentialRefs.length === 0) continue;
    if (!input.broker) {
      blockers.push(mcpCredentialBlocker(record.definition.name));
      continue;
    }
    try {
      const injection = await input.broker.getInjection({
        binding: brokerBinding(input.broker, input.agentId),
      });
      const missingRef = credentialRefs.find(
        (ref) => !injection.env[ref.name]?.trim(),
      );
      if (missingRef)
        blockers.push(mcpCredentialBlocker(record.definition.name));
    } catch (err) {
      if (
        err instanceof ApplicationError &&
        /Missing broker credential/i.test(err.message)
      ) {
        blockers.push(mcpCredentialBlocker(record.definition.name));
        continue;
      }
      blockers.push({
        state: 'broker_unreachable',
        requirementType: 'credential',
        requirementId: record.definition.name,
        message: 'Credential broker could not verify MCP credentials.',
        nextAction:
          'Connect or refresh the credential broker account, then resume or recheck the job.',
      });
    }
  }
  return blockers;
}

function mcpCredentialBlocker(serverName: string): JobSetupBlocker {
  return {
    state: 'mcp_missing_credential',
    requirementType: 'mcp_server',
    requirementId: serverName,
    message: `Required MCP server is missing a brokered credential reference: ${serverName}.`,
    nextAction:
      'Configure the MCP credential reference through the broker, then resume or recheck the job.',
  };
}

function mcpRequestAction(requirement: string): string {
  return `request_mcp_server ${JSON.stringify({
    name: requirement,
    reason: 'This autonomous run requires this MCP server.',
  })}`;
}

function brokerBinding(
  broker: AgentCredentialBroker,
  agentId: string,
): AgentCredentialBrokerBinding {
  return {
    profile: broker.getCapabilities().profile,
    purpose: 'tool_capability',
    agentIdentifier: agentId,
  };
}
