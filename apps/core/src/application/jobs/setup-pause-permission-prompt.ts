import type {
  Job,
  JobAccessRequirement,
  JobSetupBlocker,
  PermissionApprovalCancellation,
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionApprovalUpdate,
} from '../../domain/types.js';
import {
  isCanonicalBrowserCapabilityRule,
  RUN_COMMAND_TOOL_NAME,
} from '../../shared/agent-tool-references.js';
import { setupBlockerLabel } from '../../shared/job-setup-labels.js';
import { parseSemanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
import {
  formatSchedulerSetupStory,
  type SchedulerSetupStorySource,
} from './scheduler-setup-story.js';
import type { SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';
import { agentIdForJobWorkspaceKey } from './job-tool-policy.js';
import { localCliCommandTemplatePermissionRule } from './job-capability-requirements.js';
import { normalizeToolAccessRequirements } from './job-tool-access-requirements.js';
import { SETUP_REQUIRED_PAUSE_REASON } from './job-readiness-service.js';

export interface SetupPauseReviewedRequirement {
  suggestions: PermissionApprovalUpdate[];
  decisionOptions: PermissionApprovalDecisionMode[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}

export interface SetupPausePermissionPromptDeps {
  appId: string;
  getJobById(jobId: string): Promise<Job | undefined>;
  runPermissionInteraction(
    request: PermissionApprovalRequest,
    onPromptDelivered: (messageId: string) => void,
    onInteractionBegan: () => void,
  ): Promise<{
    began: boolean;
    decision: PermissionApprovalDecision;
    resolved: boolean;
  }>;
  cancelPermissionApproval(
    cancellation: PermissionApprovalCancellation,
  ): Promise<'settled' | 'queued' | 'not_found'>;
  reviewStoredRequirement(input: {
    appId: string;
    agentId: string;
    toolInput: Record<string, unknown>;
  }): Promise<SetupPauseReviewedRequirement | null>;
  resolveProviderAccountId?(job: Job): string | undefined;
}

export type SetupPausePromptResult =
  | {
      status: 'raised';
      approverRoute: SetupPausePromptRoute;
      delivered: Promise<boolean>;
    }
  | { status: 'already_pending'; approverRoute: SetupPausePromptRoute }
  | { status: 'instruction_only'; notificationEligible?: boolean };

export interface SetupPausePromptRoute {
  conversationJid: string;
  threadId: string | null;
  providerAccountId?: string;
}

let configuredDeps: SetupPausePermissionPromptDeps | null = null;

export function configureSetupPausePermissionPrompt(
  deps: SetupPausePermissionPromptDeps | null,
): void {
  configuredDeps = deps;
}

/**
 * Host-only application seam for roadmap criterion 1 (approve from card).
 * The standard permission prompt raised here owns the approval affordances;
 * scheduler setup cards intentionally do not introduce a new action kind.
 */
export async function raiseSetupPausePermissionPrompt(input: {
  jobId: string;
  setupFingerprint: string;
  previousFingerprint?: string | null;
  source?: SchedulerSetupStorySource;
  runId?: string | null;
}): Promise<SetupPausePromptResult> {
  const deps = configuredDeps;
  if (!deps) {
    return { status: 'instruction_only' };
  }
  const job = await deps.getJobById(input.jobId);
  if (!job) {
    return { status: 'instruction_only', notificationEligible: false };
  }
  const setupState = job.setup_state;
  const appId = deps.appId;
  const cancelledFingerprints = new Set<string>();
  if (
    input.previousFingerprint &&
    input.previousFingerprint !== setupState?.fingerprint
  ) {
    await cancelPrompt({
      deps,
      job,
      appId,
      fingerprint: input.previousFingerprint,
      reason: 'The job setup blockers changed.',
    });
    cancelledFingerprints.add(input.previousFingerprint);
  }
  if (
    job.silent ||
    job.status !== 'paused' ||
    job.pause_reason !== SETUP_REQUIRED_PAUSE_REASON ||
    !setupState ||
    setupState.state === 'ready' ||
    setupState.fingerprint !== input.setupFingerprint
  ) {
    if (!cancelledFingerprints.has(input.setupFingerprint)) {
      await cancelPrompt({
        deps,
        job,
        appId,
        fingerprint: input.setupFingerprint,
        reason: 'The job no longer requires this setup approval.',
      });
    }
    return { status: 'instruction_only', notificationEligible: false };
  }

  const requirement = storedGrantableRequirement(job, setupState.blockers);
  const approverRoute = setupPauseApproverRoute(job);
  if (!requirement || !approverRoute) {
    return { status: 'instruction_only', notificationEligible: true };
  }
  const agentId = agentIdForJobWorkspaceKey(job.workspace_key);
  const reviewed = await deps.reviewStoredRequirement({
    appId,
    agentId,
    toolInput: requirement.toolInput,
  });
  if (!reviewed?.suggestions.length) {
    return { status: 'instruction_only', notificationEligible: true };
  }

  const requestId = setupPausePermissionRequestId(
    job.id,
    setupState.fingerprint,
  );
  const story = formatSchedulerSetupStory({
    job,
    setupState,
    primaryBlocker: requirement.blocker,
    source: input.source,
    runId: input.runId,
  });
  const providerAccountId = deps.resolveProviderAccountId?.(job);
  const deliveredRoute = {
    ...approverRoute,
    ...(providerAccountId ? { providerAccountId } : {}),
  };
  const request: PermissionApprovalRequest = {
    requestId,
    appId,
    agentId,
    sourceAgentFolder: job.workspace_key,
    jobId: job.id,
    jobName: job.name,
    targetJid: approverRoute.conversationJid,
    approvalContextJid: approverRoute.conversationJid,
    ...(approverRoute.threadId ? { threadId: approverRoute.threadId } : {}),
    ...(providerAccountId ? { providerAccountId } : {}),
    decisionPolicy: 'same_channel',
    permissionLane: 'interactive',
    toolName: 'request_permission',
    displayName: requirement.displayName,
    title: `Approve setup for ${job.name}`,
    description:
      'Allow once is unavailable because this run already ended; lasting access is required for a future run.',
    decisionReason: story,
    toolInput: requirement.toolInput,
    suggestions: reviewed.suggestions,
    decisionOptions: reviewed.decisionOptions.filter(
      (option) => option !== 'allow_once',
    ),
    ...(reviewed.semanticCapabilityDefinitions
      ? {
          semanticCapabilityDefinitions: reviewed.semanticCapabilityDefinitions,
        }
      : {}),
  };

  let markDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => {
    markDelivered = resolve;
  });
  let markBegan!: () => void;
  const began = new Promise<void>((resolve) => {
    markBegan = resolve;
  });
  const interaction = deps.runPermissionInteraction(
    request,
    markDelivered,
    markBegan,
  );
  const deliveryResult = Promise.race([
    delivered.then(() => true),
    interaction.then(
      () => false,
      () => false,
    ),
  ]);
  const first = await Promise.race([
    began.then(() => 'raised' as const),
    interaction.then((result) =>
      result.began ? ('raised' as const) : ('already_pending' as const),
    ),
  ]);
  if (first === 'raised') {
    return {
      status: 'raised',
      approverRoute: deliveredRoute,
      delivered: deliveryResult,
    };
  }
  if (first === 'already_pending') {
    return { status: 'already_pending', approverRoute: deliveredRoute };
  }
  return { status: 'instruction_only', notificationEligible: true };
}

export async function retireSetupPausePermissionPrompt(input: {
  job: Job;
  reason: string;
}): Promise<void> {
  const deps = configuredDeps;
  if (!deps) return;
  const fingerprint = input.job.setup_state?.fingerprint;
  if (!fingerprint) return;
  await cancelPrompt({
    deps,
    job: input.job,
    appId: deps.appId,
    fingerprint,
    reason: input.reason,
  });
}

export function setupPausePermissionRequestId(
  jobId: string,
  fingerprint: string,
): string {
  return `setup-pause:${jobId}:${fingerprint}`;
}

async function cancelPrompt(input: {
  deps: SetupPausePermissionPromptDeps;
  job: Job;
  appId: string;
  fingerprint: string;
  reason: string;
}): Promise<void> {
  await input.deps.cancelPermissionApproval({
    requestId: setupPausePermissionRequestId(input.job.id, input.fingerprint),
    appId: input.appId,
    sourceAgentFolder: input.job.workspace_key,
    reason: input.reason,
  });
}

export function setupPauseApproverRoute(
  job: Job,
): SetupPausePromptRoute | null {
  const conversationJid = job.execution_context?.conversationJid?.trim();
  if (!conversationJid) return null;
  return {
    conversationJid,
    // Current jobs can store the canonical thread on either field. Keep this
    // one route helper authoritative for both prompt routing and account lookup.
    threadId: job.execution_context?.threadId ?? job.thread_id ?? null,
  };
}

function storedGrantableRequirement(
  job: Job,
  blockers: readonly JobSetupBlocker[],
): {
  blocker: JobSetupBlocker;
  displayName: string;
  toolInput: Record<string, unknown>;
} | null {
  for (const blocker of blockers) {
    if (
      blocker.state !== 'missing_capability' ||
      !['semantic_capability', 'browser', 'local_cli', 'tool'].includes(
        blocker.requirementType,
      )
    ) {
      continue;
    }
    const mapped = storedRequirementForBlocker(
      job.access_requirements ?? [],
      blocker,
    );
    if (mapped) return { blocker, ...mapped };
  }
  return null;
}

function storedRequirementForBlocker(
  requirements: readonly JobAccessRequirement[],
  blocker: JobSetupBlocker,
): { displayName: string; toolInput: Record<string, unknown> } | null {
  if (
    blocker.requirementType === 'semantic_capability' ||
    blocker.requirementType === 'local_cli'
  ) {
    const capability = requirements.find(
      (requirement) =>
        requirement.target.kind === 'capability' &&
        requirement.target.capabilityId === blocker.requirementId,
    );
    if (capability?.target.kind !== 'capability') return null;
    if (blocker.requirementType === 'local_cli') {
      const rule = localCliCommandTemplatePermissionRule(
        capability.target.implementation?.commandTemplate,
        capability.target.implementation?.executablePath,
      );
      if (!rule) return null;
      return {
        displayName: setupBlockerLabel(blocker, blocker.state),
        toolInput: {
          permissionKind: 'tool',
          toolName: RUN_COMMAND_TOOL_NAME,
          rule,
          effect: 'persistent_rule_when_always_allowed',
        },
      };
    }
    return semanticCapabilityReview(blocker.requirementId, blocker);
  }

  const storedToolRule = requirements.flatMap((requirement) => {
    if (requirement.target.kind !== 'tool_rule') return [];
    const canonicalRule = normalizeToolAccessRequirements([
      requirement.target.rule,
    ])[0];
    if (!canonicalRule) return [];
    const capabilityId = parseSemanticCapabilityRule(canonicalRule);
    return canonicalRule === blocker.requirementId ||
      capabilityId === blocker.requirementId
      ? [{ canonicalRule }]
      : [];
  })[0];
  if (!storedToolRule) return null;
  const semanticCapabilityId = parseSemanticCapabilityRule(
    storedToolRule.canonicalRule,
  );
  if (semanticCapabilityId) {
    return semanticCapabilityReview(semanticCapabilityId, blocker);
  }
  const parsedRule = splitToolRule(storedToolRule.canonicalRule);
  if (!parsedRule) return null;
  if (
    blocker.requirementType === 'browser' &&
    !isCanonicalBrowserCapabilityRule(storedToolRule.canonicalRule)
  ) {
    return null;
  }
  return {
    displayName: setupBlockerLabel(blocker, blocker.state),
    toolInput: {
      permissionKind: 'tool',
      toolName: parsedRule.toolName,
      ...(parsedRule.rule ? { rule: parsedRule.rule } : {}),
      effect: 'persistent_rule_when_always_allowed',
    },
  };
}

function semanticCapabilityReview(
  capabilityId: string,
  blocker: JobSetupBlocker,
): { displayName: string; toolInput: Record<string, unknown> } {
  return {
    displayName: setupBlockerLabel(blocker, blocker.state),
    toolInput: {
      permissionKind: 'tool',
      capabilityId,
      capabilityRequestSource: 'request_access',
      toolNames: [],
      effect: 'persistent_rule_when_always_allowed',
    },
  };
}

function splitToolRule(
  value: string,
): { toolName: string; rule?: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const open = trimmed.indexOf('(');
  if (open < 0) return { toolName: trimmed };
  if (open === 0 || !trimmed.endsWith(')')) return null;
  const toolName = trimmed.slice(0, open).trim();
  const rule = trimmed.slice(open + 1, -1).trim();
  return toolName && rule ? { toolName, rule } : null;
}
