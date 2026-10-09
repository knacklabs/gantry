import { createHash, randomUUID } from 'node:crypto';

import { decisionForMode } from '../domain/permission-decision.js';
import { PermissionLane, RailSignal } from '../domain/permission-lane.js';
import { agentIdForFolder } from '../domain/agent/agent-folder-id.js';
import type {
  ConversationRoute,
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionRiskLevel,
} from '../domain/types.js';
import {
  evaluatePermissionDeterministicRails,
  permissionRiskForDeterministicRailDecision,
  type PermissionDeterministicRailDecision,
  type PermissionDeterministicRailsInput,
} from '../domain/permission-deterministic-rails.js';
import type { AutoLaneAnalysis } from '../application/permissions/auto-lane-analysis-types.js';
import { gantryNativeCanonicalToolName } from '../application/permissions/gantry-tool-risk.js';
import type { ToolPolicyDecision } from '../shared/tool-execution-policy-service.js';
import type {
  PermissionDecisionMemoryRepository,
  PermissionDecisionMemoryRow,
} from '../domain/ports/permission-decision-memory.js';
import {
  EFFECT_SCHEMA_VERSION,
  RAIL_CATALOG_VERSION,
} from '../domain/permission-effect-key.js';
import {
  ADMIN_MCP_TOOL_NAMES,
  AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
} from '../shared/admin-mcp-tools.js';
import { canonicalJson } from '../shared/canonical-json.js';
import { canonicalizeTrustedRoot } from '../shared/permission-trusted-paths.js';
import {
  findConversationRouteForQueue,
  makeAgentThreadQueueKey,
} from '../shared/thread-queue-key.js';
import { runnerShimFamilyBypassReason } from '../shared/family-rule-synthesis.js';
import type { PermissionClassifierRiskLevel } from './permission-classifier-prompt.js';
import type { PermissionClassifierPromptConsultResult } from './permission-classifier.js';
import {
  consultRememberedAllow,
  consultRememberedDeny,
} from './permission-human-memory-stage.js';
import {
  classifierVerdictCacheKey,
  observeJudgeAvailability,
  writePermissionClassifierVerdictCache,
} from './permission-judge-outage.js';
import { projectHumanDecisionMatch } from '../application/permissions/human-decision-job-projection.js';

export type DeterministicPermissionRails = (
  input: PermissionDeterministicRailsInput,
) => PermissionDeterministicRailDecision | undefined;

/** The fixed ladder. Nothing later in the list can override an earlier stop or ask. */
export const PERMISSION_DECISION_STAGES = [
  'route',
  'hard_rules',
  'saved_approvals',
  'verdict_cache',
  'classifier',
  'ask',
] as const;

export const ADMIN_ACTION_REASON = 'Admin actions always ask a person.';
export const INVOCATION_REUSED_REASON =
  'This tool call id was already used for a different action in this run.';

// Admin actions run the host's own approval and are never covered by a saved
// approval, a cached verdict or the classifier. Proposal tools that only file
// a review a person decides on its own card (decision 0123) are not here.
const ADMIN_ACTION_TOOL_NAMES = new Set<string>(
  AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES.filter((name) =>
    (ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(name),
  ),
);

export function isAdminPermissionAction(toolName: string): boolean {
  const gantry = gantryNativeCanonicalToolName(toolName);
  return (
    gantry?.known === true && ADMIN_ACTION_TOOL_NAMES.has(gantry.canonical)
  );
}

/**
 * A rail ask that only a person may answer: real danger (destructive, secret
 * or credential paths, privilege, upload, missing or redacted input). An
 * out-of-root path, which saved folder grants exist to cover, and a command
 * shape the parser can't model go on to saved approvals and the classifier.
 */
function isHardRuleAsk(
  rail: Extract<PermissionDeterministicRailDecision, { railOutcome: 'ask' }>,
): boolean {
  return (
    rail.railSignal !== RailSignal.OutOfTrustedRoot &&
    rail.railSignal !== RailSignal.UnsupportedMetaExecutor
  );
}

export interface PermissionDecisionTailContext {
  readonly analysis?: AutoLaneAnalysis;
  readonly railDecision: PermissionDeterministicRailDecision | undefined;
  readonly canonicalRoot?: string;
  /** The classifier's ask, when it ran; absent for asks only a person may answer. */
  readonly classifierDecision?: PermissionClassifierPromptConsultResult;
}

export interface HumanDecisionProjectionInput {
  ownerPersonId: string | null;
  memory: PermissionDecisionMemoryRepository;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface CoordinatePermissionDecisionInput {
  request: PermissionApprovalRequest;
  /** Why the call is refused when the conversation's route or agent binding is gone. */
  routeRefusal?: () => string | undefined;
  hardDenyReason?: string;
  accessPreset?: 'full' | 'locked';
  fixedImageRestricted?: boolean;
  reviewedRuleDecision?:
    | ToolPolicyDecision
    | (() => Promise<ToolPolicyDecision | undefined>);
  deterministicRails?: DeterministicPermissionRails;
  deterministicRailsInput?: Omit<PermissionDeterministicRailsInput, 'request'>;
  workspaceRoot?: string;
  /** Versioned effect hash; undefined means the input can't be cached. */
  effectHash?: string;
  decisionMemory?: PermissionDecisionMemoryRepository;
  /** Set when the current tool or lane must not read or write classifier verdicts. */
  skipClassifierVerdictCache?: boolean;
  analysis?: AutoLaneAnalysis;
  humanDecisionProjection?: HumanDecisionProjectionInput;
  /**
   * The host safety judge. Absent when the agent's mode asks a person for
   * anything a hard rule or saved approval doesn't settle; the verdict cache
   * is read only when the judge would run.
   */
  consultClassifier?: () => Promise<
    PermissionClassifierPromptConsultResult | undefined
  >;
  /** The ask: show the prompt in the conversation, or attach it to the job. */
  tail: (
    context: PermissionDecisionTailContext,
  ) => Promise<PermissionApprovalDecision>;
}

/**
 * The classifier judges intrinsic risk only. Authorization was already
 * consumed by the hard-rule, saved-approval and cache stages before this
 * mapping is used.
 */
export async function coordinatePermissionClassifierRisk<T>(input: {
  riskLevel: PermissionClassifierRiskLevel;
  allow: () => T | Promise<T>;
  tail: () => Promise<T>;
}): Promise<T> {
  return input.riskLevel === 'low' || input.riskLevel === 'medium'
    ? input.allow()
    : input.tail();
}

export async function coordinatePermissionDecision(
  input: CoordinatePermissionDecisionInput,
): Promise<PermissionApprovalDecision> {
  const { request } = input;
  // 1. Route: the conversation's route and agent binding must still exist.
  const routeRefusal = input.routeRefusal?.();
  if (routeRefusal) {
    request.decisionReason = routeRefusal;
    delete request.risk_level;
    delete request.risk_category;
    return denied(request, routeRefusal, 'route');
  }
  const invocationRefusal = pinPermissionInvocationId(request);
  if (invocationRefusal) {
    return denied(request, invocationRefusal, 'invocation_id');
  }

  // 2. Hard rules and the admin always-ask bucket.
  if (input.hardDenyReason) {
    return denied(request, input.hardDenyReason, 'hard_deny');
  }
  if (input.accessPreset === 'locked') {
    return denied(
      request,
      'capability not provisioned: this agent runs with a locked access preset.',
      'locked_preset',
    );
  }
  if (input.fixedImageRestricted) {
    return denied(
      request,
      'capability not provisioned: this run uses a fixed authority image.',
      'fixed_image',
    );
  }
  const railFn =
    input.deterministicRails ?? evaluatePermissionDeterministicRails;
  const railsInput: PermissionDeterministicRailsInput = {
    request,
    ...input.deterministicRailsInput,
  };
  const railDecision = railFn(railsInput);
  if (railDecision?.railOutcome === 'deny') return railDecision;
  if (isAdminPermissionAction(request.toolName)) {
    return askPersonOnly(input, railDecision, ADMIN_ACTION_REASON);
  }
  if (railDecision?.railOutcome === 'allow') {
    // The host's reason replaces whatever the worker sent.
    if (railDecision.reason) request.decisionReason = railDecision.reason;
    return railDecision;
  }
  const railAsk =
    railDecision?.railOutcome === 'ask' ? railDecision : undefined;
  if (railAsk && isHardRuleAsk(railAsk)) {
    return askPersonOnly(input, railAsk, railAsk.reason);
  }

  // 3. Saved approvals.
  const workspaceRoot =
    input.workspaceRoot ?? input.deterministicRailsInput?.workspaceRoot;
  const rememberedDeny = await consultRememberedDeny({
    request,
    analysis: input.analysis,
    effectHash: input.effectHash,
    workspaceRoot,
    decisionMemory: input.decisionMemory,
  });
  if (rememberedDeny) return rememberedDeny;
  const reviewedRuleDecision =
    typeof input.reviewedRuleDecision === 'function'
      ? await input.reviewedRuleDecision()
      : input.reviewedRuleDecision;
  if (reviewedRuleDecision?.status === 'allow') {
    // A command-family grant covers neither a runtime shim leaf nor a path
    // outside the workspace; those go on to folder grants and the classifier.
    const familyGap =
      reviewedRuleDecision.isFamilyRule === true
        ? (familyRunnerShimReason(request) ?? railAsk?.reason)
        : undefined;
    if (!familyGap) {
      request.decisionReason = reviewedRuleDecision.reason;
      return {
        ...decisionForMode(request, 'allow_once', 'reviewed_rule', 'machine'),
        reason: reviewedRuleDecision.reason,
      };
    }
    request.decisionReason = familyGap;
  } else if (reviewedRuleDecision) {
    request.decisionReason = reviewedRuleDecision.reason;
    request.closestRule = reviewedRuleDecision.closestRule;
  }
  let trustedRootLearning: TrustedRootLearning | undefined;
  if (railAsk) {
    // An out-of-root ask can be covered by a learned folder grant, or offered
    // as an ask-once "remember this folder".
    const trustedRoot =
      railAsk.railSignal === RailSignal.OutOfTrustedRoot
        ? await resolveTrustedRootStage(input, railFn, railsInput)
        : undefined;
    if (trustedRoot?.kind === 'decision') return trustedRoot.decision;
    if (trustedRoot?.kind === 'learning') trustedRootLearning = trustedRoot;
    else request.decisionReason = railAsk.reason;
  }
  // Remembered person approvals cover a soft rail ask only where they always
  // have: outside the workspace, or a read-only find the parser can't model.
  const rememberedAllowsApply =
    !railAsk ||
    railAsk.railSignal === RailSignal.OutOfTrustedRoot ||
    input.analysis?.readOnlyMetaExecutor === true;
  if (
    rememberedAllowsApply &&
    railAsk?.hardFloor !== true &&
    input.analysis?.lane === PermissionLane.Autonomous &&
    input.humanDecisionProjection &&
    workspaceRoot
  ) {
    const match = await projectHumanDecisionMatch({
      ownerPersonId: input.humanDecisionProjection.ownerPersonId,
      request,
      facts: {
        effectHash: input.effectHash,
        workspaceRoot,
        canonicalRoot: trustedRootLearning?.canonicalRoot,
      },
      railVersion: RAIL_CATALOG_VERSION,
      memory: input.humanDecisionProjection.memory,
      warn: input.humanDecisionProjection.warn,
    });
    if (match) {
      return {
        ...decisionForMode(request, 'allow_once', 'human_decision', 'machine'),
        humanDecisionRecordId: match.recordId,
      };
    }
  }
  const rememberedAllow = rememberedAllowsApply
    ? await consultRememberedAllow({
        request,
        analysis: input.analysis,
        effectHash: input.effectHash,
        workspaceRoot,
        canonicalRoot: trustedRootLearning?.canonicalRoot,
        decisionMemory: input.decisionMemory,
      })
    : undefined;
  if (rememberedAllow) return rememberedAllow;

  // 4. Verdict cache: a shortcut for the classifier, read only where it runs.
  const cacheKey =
    input.consultClassifier &&
    input.analysis &&
    input.effectHash &&
    input.decisionMemory &&
    !input.skipClassifierVerdictCache &&
    !railAsk
      ? classifierVerdictCacheKey({
          effectHash: input.effectHash,
          lane: input.analysis.lane,
        })
      : undefined;
  if (cacheKey) {
    const cached = await input.decisionMemory!.getClassifierVerdict({
      appId: request.appId ?? 'default',
      agentFolder: request.sourceAgentFolder,
      effectHash: cacheKey,
    });
    if (cached?.decision === 'allow') {
      request.risk_level = cached.risk_level;
      if (cached.risk_category) request.risk_category = cached.risk_category;
      return {
        ...decisionForMode(
          request,
          'allow_once',
          'cached_classifier_verdict',
          'machine',
        ),
        reason: cached.reason,
        risk_level: cached.risk_level,
        ...(cached.risk_category
          ? { risk_category: cached.risk_category }
          : {}),
      };
    }
  }

  // 5. Classifier: it only allows or asks, and its allow is final.
  let classifierDecision: PermissionClassifierPromptConsultResult | undefined;
  if (input.consultClassifier) {
    const verdict = await input.consultClassifier();
    if (verdict) {
      applyClassifierRisk(request, railDecision, verdict);
      request.decisionReason = observeJudgeAvailability(verdict, request);
      if (cacheKey) {
        await writePermissionClassifierVerdictCache({
          verdict,
          lane: input.analysis!.lane,
          request,
          cacheKey,
          decisionMemory: input.decisionMemory!,
        });
      }
      if (verdict.decision === 'allow') {
        return {
          ...decisionForMode(
            request,
            'allow_once',
            'auto_classifier',
            'machine',
          ),
          ...(railAsk
            ? {
                railProvenance: {
                  signal: railAsk.railSignal,
                  reason: railAsk.reason,
                },
              }
            : {}),
          ...requestRisk(request),
        };
      }
      if (verdict.denylistHit) {
        // A saved rule would never be honoured while the denylist blocks it.
        request.suggestions = undefined;
        request.decisionOptions = ['allow_once', 'cancel'];
      }
      classifierDecision = verdict;
    }
  }

  // 6. Ask a person, or attach the ask to the job.
  return completeTrustedRootLearning(
    input,
    trustedRootLearning,
    await input.tail(
      Object.freeze({
        ...(input.analysis ? { analysis: input.analysis } : {}),
        railDecision,
        ...(trustedRootLearning
          ? { canonicalRoot: trustedRootLearning.canonicalRoot }
          : {}),
        ...(classifierDecision ? { classifierDecision } : {}),
      }),
    ),
  );
}

/** The live route that binds this agent to the conversation, if it still exists. */
export function findPermissionRoute(input: {
  routes: Record<string, ConversationRoute>;
  targetJid?: string;
  agentId: string;
  threadId?: string;
  providerAccountId?: string;
}): ConversationRoute | undefined {
  return input.targetJid
    ? findConversationRouteForQueue(
        input.routes,
        makeAgentThreadQueueKey(
          input.targetJid,
          input.agentId,
          input.threadId,
          input.providerAccountId,
        ),
        (route) => route.agentId ?? agentIdForFolder(route.folder),
      )
    : undefined;
}

export function missingPermissionRouteReason(toolName: string): string {
  return `Permission approval is unavailable: ${toolName} has no deliverable approver route, because this conversation's route or agent binding is gone.`;
}

/** Hard-rule and admin asks: no saved approval, cache or classifier may answer, and nothing is offered for the future. */
function askPersonOnly(
  input: CoordinatePermissionDecisionInput,
  railDecision: PermissionDeterministicRailDecision | undefined,
  reason: string,
): Promise<PermissionApprovalDecision> {
  input.request.decisionReason = reason;
  input.request.suggestions = [];
  input.request.decisionOptions = ['allow_once', 'cancel'];
  const railRisk = permissionRiskForDeterministicRailDecision(railDecision);
  if (railRisk) {
    input.request.risk_level = railRisk.level;
    input.request.risk_category = railRisk.category;
  }
  return input.tail(
    Object.freeze({
      ...(input.analysis ? { analysis: input.analysis } : {}),
      railDecision,
    }),
  );
}

function familyRunnerShimReason(
  request: PermissionApprovalRequest,
): string | undefined {
  const command = (request.toolInput as { command?: unknown } | undefined)
    ?.command;
  if (typeof command !== 'string') return undefined;
  return runnerShimFamilyBypassReason(command);
}

const ENGINE_INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
// ponytail: in-process bindings, oldest evicted past 10k; move them to the
// waiting record if an id must stay bound across a restart.
const MAX_INVOCATION_BINDINGS = 10_000;
const invocationBindings = new Map<string, string>();

/**
 * Pins the engine's tool-call id (SDK tool-use id or LangChain tool-call id)
 * to the authenticated run, app and agent, bound to a hash of the action. A
 * missing or malformed id, or one with no run to scope it, gets a fresh host
 * id. Returns why the call is refused when the id was already used in this
 * run for a different action.
 */
export function pinPermissionInvocationId(
  request: PermissionApprovalRequest,
): string | undefined {
  const engineId = request.invocationId?.trim();
  if (!engineId || !ENGINE_INVOCATION_ID.test(engineId) || !request.runId) {
    request.invocationId = `host:${randomUUID()}`;
    return undefined;
  }
  request.invocationId = engineId;
  const scope = [
    request.appId ?? 'default',
    request.agentId ?? '',
    request.sourceAgentFolder,
    request.runId,
    engineId,
  ].join('\u0000');
  const action = permissionActionHash(request);
  const bound = invocationBindings.get(scope);
  if (bound !== undefined) {
    return bound === action ? undefined : INVOCATION_REUSED_REASON;
  }
  if (invocationBindings.size >= MAX_INVOCATION_BINDINGS) {
    invocationBindings.delete(invocationBindings.keys().next().value!);
  }
  invocationBindings.set(scope, action);
  return undefined;
}

/** The same call under two names (`send_message`, `mcp__gantry__send_message`) hashes the same. */
function permissionActionHash(request: PermissionApprovalRequest): string {
  const toolName =
    gantryNativeCanonicalToolName(request.toolName)?.canonical ??
    request.toolName;
  return createHash('sha256')
    .update(
      canonicalJson([
        toolName,
        request.classifierToolInput ?? request.toolInput ?? null,
      ]),
    )
    .digest('hex');
}

function applyClassifierRisk(
  request: PermissionApprovalRequest,
  railDecision: PermissionDeterministicRailDecision | undefined,
  verdict: PermissionClassifierPromptConsultResult,
): void {
  const primaryRisk = selectPrimaryPermissionRisk(
    permissionRiskForDeterministicRailDecision(railDecision),
    { level: verdict.risk_level, category: verdict.risk_category },
  );
  if (!primaryRisk) return;
  request.risk_level = primaryRisk.level;
  if (primaryRisk.category) {
    request.risk_category = primaryRisk.category;
  } else {
    delete request.risk_category;
  }
}

function requestRisk(
  request: PermissionApprovalRequest,
): Pick<PermissionApprovalDecision, 'risk_level' | 'risk_category'> {
  return {
    ...(request.risk_level ? { risk_level: request.risk_level } : {}),
    ...(request.risk_category ? { risk_category: request.risk_category } : {}),
  };
}

const PERMISSION_RISK_SEVERITY_RANK: Record<PermissionRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

type PermissionRiskSignal = {
  level: PermissionRiskLevel;
  category?: PermissionApprovalRequest['risk_category'];
};

function selectPrimaryPermissionRisk(
  railRisk: PermissionRiskSignal | undefined,
  classifierRisk: PermissionRiskSignal | undefined,
): PermissionRiskSignal | undefined {
  if (!railRisk) return classifierRisk;
  if (!classifierRisk) return railRisk;
  if (
    PERMISSION_RISK_SEVERITY_RANK[classifierRisk.level] <=
    PERMISSION_RISK_SEVERITY_RANK[railRisk.level]
  ) {
    return railRisk;
  }
  return classifierRisk.category && classifierRisk.category !== 'benign'
    ? classifierRisk
    : { ...railRisk, level: classifierRisk.level };
}

const TRUSTED_ROOT_LEARN_OPTIONS: PermissionApprovalDecisionMode[] = [
  // Renders with existing labels: "Allow for future" = remember this folder,
  // "Allow once" = once, "Cancel" = deny. No new decision mode threaded through
  // the channels — the persistent-rule option carries the "this folder" intent.
  'allow_persistent_rule',
  'allow_once',
  'cancel',
];

interface TrustedRootLearning {
  readonly kind: 'learning';
  readonly canonicalRoot: string;
  readonly memory: PermissionDecisionMemoryRepository;
}

type TrustedRootStageResult =
  | TrustedRootLearning
  | {
      readonly kind: 'decision';
      readonly decision: PermissionApprovalDecision;
    };

/**
 * Learned trusted-root stage (Task G). Reached only when rails ASK, so a
 * destructive/secret/escape command has already asked and can never be learned.
 * A grant that covers the command's canonical cwd/targets auto-allows it; a
 * first, coherent out-of-root command is offered an ask-once "remember this
 * folder" and, on approval, persisted so later ops in that root auto-allow.
 */
async function resolveTrustedRootStage(
  input: CoordinatePermissionDecisionInput,
  railFn: DeterministicPermissionRails,
  railsInput: PermissionDeterministicRailsInput,
): Promise<TrustedRootStageResult | undefined> {
  const workspaceRoot = input.deterministicRailsInput?.workspaceRoot;
  const memory = input.decisionMemory;
  // No repository (or one without trusted-root support) ⇒ no grant to read and
  // nowhere to persist one, so leave the ask for the normal classifier/human
  // tail. `typeof list` guards partial memory ports (a synchronous "not a
  // function" throw would slip past the .catch on the list() call below).
  if (!workspaceRoot || typeof memory?.list !== 'function') return undefined;

  // "root clears the ask" ⇔ trusting `root` removes the sole ASK reason. It
  // re-runs the SAME rails with `root` added, so containment, sibling scoping
  // and symlink-escape all reuse PERM-1's realpath check (a destructive/secret
  // ask survives the extra root, so the grant/learn paths never fire for it).
  const clears = (root: string): boolean => {
    const rerun = railFn({
      ...railsInput,
      trustedRoots: [...(railsInput.trustedRoots ?? []), root],
    });
    return !rerun || rerun.railOutcome !== 'ask';
  };

  const grants = await memory
    .list({
      appId: input.request.appId ?? 'default',
      agentFolder: input.request.sourceAgentFolder,
      kind: 'trusted_root',
    })
    // ponytail: queried on every ASK; gate on `clears(cwd)` first if the
    // scoped list ever shows up hot.
    .catch(() => [] as PermissionDecisionMemoryRow[]);
  const now = new Date().toISOString();
  for (const grant of grants) {
    if (
      grant.canonicalRoot &&
      isActiveGrant(grant, now) &&
      clears(grant.canonicalRoot)
    ) {
      return {
        kind: 'decision',
        decision: grantAllow(input.request, grant.canonicalRoot),
      };
    }
  }

  const canonicalRoot = canonicalizeTrustedRoot(workspaceRoot);
  // Only a coherent single folder is learnable: trusting the cwd must clear the
  // ask. If a target escapes the cwd, the ask survives and we fall to a plain
  // prompt rather than offering to remember a root that would not cover it.
  if (!clears(canonicalRoot)) return undefined;

  input.request.decisionReason = `First command in a new folder: ${canonicalRoot}.`;
  input.request.decisionOptions = [...TRUSTED_ROOT_LEARN_OPTIONS];
  input.request.trustedRootLearn = true;
  return { kind: 'learning', canonicalRoot, memory };
}

async function completeTrustedRootLearning(
  input: CoordinatePermissionDecisionInput,
  learning: TrustedRootLearning | undefined,
  decision: PermissionApprovalDecision,
): Promise<PermissionApprovalDecision> {
  if (!learning) return decision;
  const { canonicalRoot, memory } = learning;
  if (decision.approved && decision.mode === 'allow_persistent_rule') {
    const principal = decision.decidedBy ?? 'owner';
    await memory
      .put({
        id: randomUUID(),
        appId: input.request.appId ?? 'default',
        agentFolder: input.request.sourceAgentFolder,
        kind: 'trusted_root',
        lookupIdentity: `${canonicalRoot}\u0000${principal}`,
        reason: `Owner granted trusted root ${canonicalRoot}.`,
        canonicalRoot,
        principal,
        effectSchemaVersion: EFFECT_SCHEMA_VERSION,
        railVersion: RAIL_CATALOG_VERSION,
        provenance: 'human_trusted_root',
        nowIso: new Date().toISOString(),
      })
      // ponytail: a grant-write failure must never block the live allow.
      .catch(() => undefined);
    return grantAllow(input.request, canonicalRoot);
  }
  return decision;
}

function isActiveGrant(
  grant: PermissionDecisionMemoryRow,
  nowIso: string,
): boolean {
  return !grant.revokedAt && (!grant.expiresAt || grant.expiresAt > nowIso);
}

function grantAllow(
  request: PermissionApprovalRequest,
  canonicalRoot: string,
): PermissionApprovalDecision {
  return {
    ...decisionForMode(request, 'allow_once', 'trusted_root_grant', 'machine'),
    reason: `Command runs inside a granted trusted root: ${canonicalRoot}.`,
  };
}

export interface PermissionRunRestriction {
  hideAuthorityTools: boolean;
  runKind: 'interactive' | 'scheduled';
  memoryUserId?: string;
  memoryUserLabel?: string;
  jobId?: string;
  runId?: string;
  parentTaskId?: string;
}

const permissionRunRestrictions = new Map<string, PermissionRunRestriction>();

export function registerPermissionRunRestriction(input: {
  sourceAgentFolder: string;
  responseKeyId: string;
  hideAuthorityTools: boolean;
  runKind: 'interactive' | 'scheduled';
  memoryUserId?: string;
  memoryUserLabel?: string;
  jobId?: string;
  runId?: string;
  parentTaskId?: string;
}): void {
  permissionRunRestrictions.set(restrictionKey(input), {
    hideAuthorityTools: input.hideAuthorityTools,
    runKind: input.runKind,
    ...(input.memoryUserId ? { memoryUserId: input.memoryUserId } : {}),
    ...(input.memoryUserLabel
      ? { memoryUserLabel: input.memoryUserLabel }
      : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
  });
}

export function permissionRunRestriction(input: {
  sourceAgentFolder: string;
  responseKeyId: string;
}): PermissionRunRestriction | undefined {
  return permissionRunRestrictions.get(restrictionKey(input));
}

export function unregisterPermissionRunRestriction(input: {
  sourceAgentFolder: string;
  responseKeyId: string;
}): void {
  permissionRunRestrictions.delete(restrictionKey(input));
}

function restrictionKey(input: {
  sourceAgentFolder: string;
  responseKeyId: string;
}): string {
  return `${input.sourceAgentFolder}\u0000${input.responseKeyId}`;
}

function denied(
  request: PermissionApprovalRequest,
  reason: string,
  decidedBy: string,
): PermissionApprovalDecision {
  return {
    ...decisionForMode(request, 'cancel', decidedBy, 'machine'),
    reason,
  };
}
