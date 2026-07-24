import { randomUUID } from 'node:crypto';

import { decisionForMode } from '../domain/permission-decision.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
} from '../domain/types.js';
import {
  evaluatePermissionDeterministicRails,
  type PermissionDeterministicRailDecision,
  type PermissionDeterministicRailsInput,
} from '../domain/permission-deterministic-rails.js';
import type { ToolPolicyDecision } from '../shared/tool-execution-policy-service.js';
import type {
  PermissionDecisionMemoryRepository,
  PermissionDecisionMemoryRow,
} from '../domain/ports/permission-decision-memory.js';
import {
  EFFECT_SCHEMA_VERSION,
  RAIL_CATALOG_VERSION,
} from '../domain/permission-effect-key.js';
import { canonicalizeTrustedRoot } from '../shared/permission-trusted-paths.js';
import type { PermissionClassifierRiskLevel } from './permission-classifier-prompt.js';

export type DeterministicPermissionRails = (
  input: PermissionDeterministicRailsInput,
) => PermissionDeterministicRailDecision | undefined;

export interface CoordinatePermissionDecisionInput {
  request: PermissionApprovalRequest;
  hardDenyReason?: string;
  accessPreset?: 'full' | 'locked';
  fixedImageRestricted?: boolean;
  reviewedRuleDecision?:
    | ToolPolicyDecision
    | (() => Promise<ToolPolicyDecision | undefined>);
  deterministicRails?: DeterministicPermissionRails;
  deterministicRailsInput?: Omit<PermissionDeterministicRailsInput, 'request'>;
  /** Versioned effect hash (Task B); undefined ⇒ input uncacheable, cache skipped. */
  effectHash?: string;
  /** Classifier-verdict cache (Task C); read only on a rail fall-through. */
  decisionMemory?: PermissionDecisionMemoryRepository;
  tail: () => Promise<PermissionApprovalDecision>;
}

/**
 * The classifier judges intrinsic risk only. Authorization was already
 * consumed by the hard-deny, reviewed-rule/capability, deterministic-rail,
 * grant, and cache stages before this mapping is used.
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
  if (input.hardDenyReason) {
    return denied(input.request, input.hardDenyReason, 'hard_deny');
  }
  if (input.accessPreset === 'locked') {
    return denied(
      input.request,
      'capability not provisioned: this agent runs with a locked access preset.',
      'locked_preset',
    );
  }
  if (input.fixedImageRestricted) {
    return denied(
      input.request,
      'capability not provisioned: this run uses a fixed authority image.',
      'fixed_image',
    );
  }
  const reviewedRuleDecision =
    typeof input.reviewedRuleDecision === 'function'
      ? await input.reviewedRuleDecision()
      : input.reviewedRuleDecision;
  if (reviewedRuleDecision?.status === 'allow') {
    return {
      ...decisionForMode(input.request, 'allow_once', 'reviewed_rule'),
      reason: reviewedRuleDecision.reason,
    };
  }
  if (reviewedRuleDecision) {
    input.request.decisionReason = reviewedRuleDecision.reason;
    input.request.closestRule = reviewedRuleDecision.closestRule;
  }
  const railFn =
    input.deterministicRails ?? evaluatePermissionDeterministicRails;
  const railsInput: PermissionDeterministicRailsInput = {
    request: input.request,
    ...input.deterministicRailsInput,
  };
  const railDecision = railFn(railsInput);
  // Rails re-run on EVERY call, BEFORE any cache read (re-run-every-hit): a
  // deny/allow floor wins unchanged, and an ask-floor overrides even a cached
  // allow — so the cache is consulted ONLY when rails fall through entirely.
  if (railDecision) {
    if (railDecision.railOutcome === 'ask') {
      // Trusted-root stage (Task G): an out-of-root ask can be covered by a
      // learned grant, or offered as an ask-once "remember this folder". Rails
      // still ran first, so a destructive/secret/escape ask is never learnable.
      const trustedRoot = await resolveTrustedRootStage(
        input,
        railFn,
        railsInput,
      );
      if (trustedRoot) return trustedRoot;
      input.request.decisionReason = railDecision.reason;
      return input.tail();
    }
    return railDecision;
  }
  // CACHE STAGE (cache-hit-only shortcut). Reachable only past hard-deny/
  // locked/fixed-image (PERM-1 precedence, checked above) and past the rails.
  if (input.effectHash && input.decisionMemory) {
    const cached = await input.decisionMemory.getClassifierVerdict({
      appId: input.request.appId ?? 'default',
      agentFolder: input.request.sourceAgentFolder,
      effectHash: input.effectHash,
    });
    if (cached?.decision === 'allow') {
      return {
        ...decisionForMode(
          input.request,
          'allow_once',
          'cached_classifier_verdict',
        ),
        reason: cached.reason,
      };
    }
  }
  return input.tail();
}

const TRUSTED_ROOT_LEARN_OPTIONS: PermissionApprovalDecisionMode[] = [
  // Renders with existing labels: "Allow for future" = remember this folder,
  // "Allow once" = once, "Cancel" = deny. No new decision mode threaded through
  // the channels — the persistent-rule option carries the "this folder" intent.
  'allow_persistent_rule',
  'allow_once',
  'cancel',
];

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
): Promise<PermissionApprovalDecision | undefined> {
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
      return grantAllow(input.request, grant.canonicalRoot);
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
  const decision = await input.tail();
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
    ...decisionForMode(request, 'allow_once', 'trusted_root_grant'),
    reason: `Command runs inside a granted trusted root: ${canonicalRoot}.`,
  };
}

interface PermissionRunRestriction {
  hideAuthorityTools: boolean;
}

const permissionRunRestrictions = new Map<string, PermissionRunRestriction>();

export function registerPermissionRunRestriction(input: {
  sourceAgentFolder: string;
  responseKeyId: string;
  hideAuthorityTools: boolean;
}): void {
  permissionRunRestrictions.set(restrictionKey(input), {
    hideAuthorityTools: input.hideAuthorityTools,
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
    ...decisionForMode(request, 'cancel', decidedBy),
    reason,
  };
}
