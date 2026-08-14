import type {
  Job,
  JobAccessRequirement,
  JobSetupBlocker,
  PermissionApprovalCancellation,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionApprovalUpdate,
} from '../../domain/types.js';
import { SEMANTIC_CAPABILITY_RULE_PREFIX } from '../../shared/semantic-capability-ids.js';
import { setupBlockerLabel } from '../../shared/job-setup-labels.js';
import {
  formatSchedulerSetupStory,
  type SchedulerSetupStorySource,
} from './scheduler-setup-story.js';
import type { SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';
import { agentIdForJobWorkspaceKey } from './job-tool-policy.js';
import { SETUP_REQUIRED_PAUSE_REASON } from './job-readiness-service.js';
import { permissionUpdateAllowedToolRules } from '../../shared/permission-tool-rules.js';

export interface SetupPauseReviewedRequirement {
  suggestions: PermissionApprovalUpdate[];
  decisionOptions: PermissionApprovalDecisionMode[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}

export interface SetupPausePermissionPromptDeps {
  appId: string;
  getJobById(jobId: string): Promise<Job | undefined>;
  preparePermissionInteraction(
    request: PermissionApprovalRequest,
  ): Promise<{ created: boolean }>;
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

  const requirements = grantableRequirementCandidates(job, setupState.blockers);
  const approverRoute = setupPauseApproverRoute(job);
  if (!requirements.length || !approverRoute) {
    return { status: 'instruction_only', notificationEligible: true };
  }
  const agentId = agentIdForJobWorkspaceKey(job.workspace_key);
  let selected:
    | {
        requirement: (typeof requirements)[number];
        reviewed: SetupPauseReviewedRequirement;
      }
    | undefined;
  for (const requirement of requirements) {
    const reviewed = await deps.reviewStoredRequirement({
      appId,
      agentId,
      toolInput: requirement.toolInput,
    });
    if (reviewed?.suggestions.length) {
      selected = { requirement, reviewed };
      break;
    }
  }
  if (!selected) {
    return { status: 'instruction_only', notificationEligible: true };
  }
  const { requirement, reviewed } = selected;

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
    setupFingerprint: setupState.fingerprint,
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

  let prepared: { created: boolean };
  try {
    prepared = await deps.preparePermissionInteraction(request);
  } catch {
    // A failed preparation stays RETRYABLE: notificationEligible false so
    // the prose path cannot consume notified_fingerprint - the very trap
    // that produced the never-fired button. The next readiness tick
    // re-raises and re-attempts the durable enqueue (review R5/R7).
    // Runtimes with NO outbound repository never configure these deps at
    // all and take the depless prose path above instead.
    return { status: 'instruction_only', notificationEligible: false };
  }
  if (prepared.created) {
    return {
      status: 'raised',
      approverRoute: deliveredRoute,
    };
  }
  return { status: 'already_pending', approverRoute: deliveredRoute };
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

interface GrantableRequirementCandidate {
  blocker: JobSetupBlocker;
  rule: { toolName: string; ruleContent?: string };
  displayName: string;
  toolInput: Record<string, unknown>;
  suggestedRequirement?: JobAccessRequirement;
}

function grantableRequirementCandidates(
  job: Job,
  blockers: readonly JobSetupBlocker[],
): GrantableRequirementCandidate[] {
  return blockers.flatMap((blocker) => {
    if (
      blocker.state !== 'missing_capability' ||
      blocker.action.kind !== 'approve_grant' ||
      // Prompt candidates and completion agree (R8/R9): only a plain
      // addRules grant without an explicit destination gets the one-tap
      // card + auto-append path. Other accepted variants surface as
      // display-only blockers - no card promise this path cannot complete.
      blocker.action.grant.type !== 'addRules' ||
      blocker.action.grant.destination !== undefined
    ) {
      return [];
    }
    // A valid grant may carry up to five rules - EVERY rule becomes a
    // candidate; consuming only rules[0] would silently drop the rest from
    // the approval request and the suggested requirements (review R2).
    return blocker.action.grant.rules.map((rule) => {
      const toolInput = rule.toolName.startsWith('capability:')
        ? {
            permissionKind: 'tool',
            capabilityId: rule.toolName.slice('capability:'.length),
            capabilityRequestSource: 'request_access',
            toolNames: [],
            effect: 'persistent_rule_when_always_allowed',
          }
        : {
            permissionKind: 'tool',
            toolName: rule.toolName,
            ...(rule.ruleContent ? { rule: rule.ruleContent } : {}),
            effect: 'persistent_rule_when_always_allowed',
          };
      const suggestedRequirement = requirementForRule(job, blocker, rule);
      return {
        blocker,
        rule,
        displayName: setupBlockerLabel(blocker, blocker.state),
        toolInput,
        ...(suggestedRequirement ? { suggestedRequirement } : {}),
      };
    });
  });
}

export function setupPauseRequirementForApprovedSuggestions(input: {
  job: Job;
  suggestions: readonly PermissionApprovalUpdate[];
}): { matched: boolean; requirements?: JobAccessRequirement[] } {
  const approvedRules = permissionUpdateAllowedToolRules(input.suggestions);
  if (approvedRules.length === 0) return { matched: false };
  const candidates = grantableRequirementCandidates(
    input.job,
    input.job.setup_state?.blockers ?? [],
  );
  // Review R3: an approval satisfies a grant action only when it covers the
  // action's COMPLETE rule set - a partial approval must not resume the job
  // with part of the typed authority applied - and every corresponding
  // requirement is returned so all of them get appended.
  const approvedSet = new Set(approvedRules);
  const byBlocker = new Map<JobSetupBlocker, GrantableRequirementCandidate[]>();
  for (const candidate of candidates) {
    const group = byBlocker.get(candidate.blocker) ?? [];
    group.push(candidate);
    byBlocker.set(candidate.blocker, group);
  }
  // One interaction may approve SEVERAL independent blockers: a group matches
  // when its COMPLETE rule set is covered by the approval (subset, not
  // equality with the global union) - and every matched group's requirements
  // are appended (review R8).
  const matchedRequirements: JobAccessRequirement[] = [];
  let anyMatched = false;
  for (const [, group] of byBlocker) {
    const groupRules = group.map((candidate) => candidateRule(candidate));
    if (
      groupRules.length > 0 &&
      groupRules.every((rule) => rule !== undefined && approvedSet.has(rule))
    ) {
      anyMatched = true;
      matchedRequirements.push(
        ...group.flatMap((candidate) =>
          candidate.suggestedRequirement
            ? [candidate.suggestedRequirement]
            : [],
        ),
      );
    }
  }
  if (!anyMatched) return { matched: false };
  return { matched: true, requirements: matchedRequirements };
}

function candidateRule(
  candidate: GrantableRequirementCandidate,
): string | undefined {
  const capabilityId =
    typeof candidate.toolInput.capabilityId === 'string'
      ? candidate.toolInput.capabilityId
      : undefined;
  if (capabilityId) return `capability:${capabilityId}`;
  const toolName =
    typeof candidate.toolInput.toolName === 'string'
      ? candidate.toolInput.toolName
      : undefined;
  const rule =
    typeof candidate.toolInput.rule === 'string'
      ? candidate.toolInput.rule
      : undefined;
  if (!toolName) return undefined;
  return permissionUpdateAllowedToolRules([
    {
      type: 'addRules',
      behavior: 'allow',
      rules: [{ toolName, ...(rule ? { ruleContent: rule } : {}) }],
    },
  ])[0];
}

function requirementForRule(
  job: Job,
  blocker: JobSetupBlocker,
  grantRule: { toolName: string; ruleContent?: string },
): JobAccessRequirement | undefined {
  // Review R1: blocker.id may carry the canonical capability: rule prefix -
  // requirements store the BARE capability id, so normalize before matching
  // and before appending (a prefixed id would both miss the existing
  // requirement and append an invalid duplicate).
  const capabilityId = blocker.id.startsWith(SEMANTIC_CAPABILITY_RULE_PREFIX)
    ? blocker.id.slice(SEMANTIC_CAPABILITY_RULE_PREFIX.length)
    : blocker.id;
  const canonicalRule = grantRule.ruleContent
    ? `${grantRule.toolName}(${grantRule.ruleContent})`
    : grantRule.toolName;
  const existing = (job.access_requirements ?? []).find((requirement) => {
    if (requirement.target.kind === 'capability') {
      return requirement.target.capabilityId === capabilityId;
    }
    // Review R1: an existing tool_rule only satisfies this blocker when it
    // matches the EXACT canonical rule the grant carries - a differently
    // scoped RunCommand rule must not suppress the new declaration.
    return (
      requirement.target.kind === 'tool_rule' &&
      requirement.target.rule === canonicalRule
    );
  });
  if (existing) return undefined;
  if (blocker.type === 'semantic_capability') {
    return {
      target: { kind: 'capability', capabilityId },
      reason: `Required after ${setupBlockerLabel(blocker, blocker.state)} was denied.`,
    };
  }

  return {
    target: {
      kind: 'tool_rule',
      rule: canonicalRule,
    },
    reason: `Required after ${setupBlockerLabel(blocker, blocker.state)} was denied.`,
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
