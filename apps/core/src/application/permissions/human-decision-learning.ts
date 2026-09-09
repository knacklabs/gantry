import {
  HumanDecisionOutcome,
  HumanDecisionScope,
  type PermissionRememberResolution,
} from '../../domain/human-decision.js';
import {
  PermissionLane,
  type PermissionLane as PermissionLaneValue,
} from '../../domain/permission-lane.js';
import type { PermissionApprovalRequest } from '../../domain/types.js';
import type { PermissionMode } from '../../shared/permission-mode.js';
import { deriveAutoLaneAnalysis } from './auto-lane-analysis.js';
import type { AutoLaneAnalysis } from './auto-lane-analysis-types.js';
import type {
  HumanDecisionMemoryService,
  HumanDecisionServiceRefusal,
} from './human-decision-memory-service.js';
import {
  deriveHumanDecisionScopeKey,
  HumanDecisionNotRememberableReason,
  type HumanDecisionScopeKeyResult,
} from './human-decision-scope.js';

export interface PermissionRememberContext {
  eligible: boolean;
  laneInput: { permissionMode: PermissionMode; hostJobId?: string };
  lane: PermissionLaneValue;
  appId: string;
  agentFolder: string;
  canonicalTool: string;
  personId?: string;
  personLabel?: string;
  effectHash: string;
  effectSchemaVersion: number;
  railVersion: number;
  workspaceRoot?: string;
  kindVariant: 'category' | 'tool';
  candidates: {
    deny: HumanDecisionScopeKeyResult;
    exact: HumanDecisionScopeKeyResult;
    kind: HumanDecisionScopeKeyResult;
    kindTool: HumanDecisionScopeKeyResult;
    place: HumanDecisionScopeKeyResult;
  };
}

export interface PermissionRememberPromptFacts {
  analysis: AutoLaneAnalysis;
  effectHash?: string;
  workspaceRoot?: string;
  canonicalRoot?: string;
}

export async function derivePermissionRememberContext(input: {
  request: PermissionApprovalRequest;
  facts: PermissionRememberPromptFacts;
  laneInput: PermissionRememberContext['laneInput'];
  appId: string;
  agentFolder: string;
  canonicalTool: string;
  personId?: string;
  personLabel?: string;
  effectSchemaVersion: number;
  railVersion: number;
  kindVariant: PermissionRememberContext['kindVariant'];
}): Promise<PermissionRememberContext> {
  const candidateInput = {
    request: input.request,
    effectHash: input.facts.effectHash,
    workspaceRoot: input.facts.workspaceRoot,
    canonicalRoot: input.facts.canonicalRoot,
  };
  const [deny, exact, kind, kindTool, place] = await Promise.all([
    deriveHumanDecisionScopeKey({
      ...candidateInput,
      outcome: HumanDecisionOutcome.Deny,
      scope: HumanDecisionScope.Exact,
      trustGrowthTool: false,
    }),
    deriveHumanDecisionScopeKey({
      ...candidateInput,
      outcome: HumanDecisionOutcome.Allow,
      scope: HumanDecisionScope.Exact,
      trustGrowthTool: false,
    }),
    deriveHumanDecisionScopeKey({
      ...candidateInput,
      outcome: HumanDecisionOutcome.Allow,
      scope: HumanDecisionScope.Kind,
      trustGrowthTool: false,
    }),
    deriveHumanDecisionScopeKey({
      ...candidateInput,
      outcome: HumanDecisionOutcome.Allow,
      scope: HumanDecisionScope.Kind,
      trustGrowthTool: true,
    }),
    deriveHumanDecisionScopeKey({
      ...candidateInput,
      outcome: HumanDecisionOutcome.Allow,
      scope: HumanDecisionScope.Place,
      trustGrowthTool: false,
    }),
  ]);
  const personId = input.personId?.trim() || undefined;
  return {
    eligible:
      input.facts.analysis.lane === PermissionLane.InteractiveAuto &&
      !input.laneInput.hostJobId &&
      Boolean(personId && input.facts.effectHash?.trim()),
    laneInput: { ...input.laneInput },
    lane: input.facts.analysis.lane,
    appId: input.appId,
    agentFolder: input.agentFolder,
    canonicalTool: input.canonicalTool,
    ...(personId ? { personId } : {}),
    ...(input.personLabel !== undefined
      ? { personLabel: input.personLabel }
      : {}),
    effectHash: input.facts.effectHash ?? '',
    effectSchemaVersion: input.effectSchemaVersion,
    railVersion: input.railVersion,
    ...(input.facts.workspaceRoot !== undefined
      ? { workspaceRoot: input.facts.workspaceRoot }
      : {}),
    kindVariant: input.kindVariant,
    candidates: { deny, exact, kind, kindTool, place },
  };
}

export function parsePermissionRememberContext(
  value: unknown,
): PermissionRememberContext | null {
  if (!isRecord(value) || typeof value.eligible !== 'boolean') return null;
  const laneInput = parseLaneInput(value.laneInput);
  const candidates = parseCandidates(value.candidates);
  if (
    !laneInput ||
    !candidates ||
    !isPermissionLane(value.lane) ||
    !isNonEmptyString(value.appId) ||
    !isNonEmptyString(value.agentFolder) ||
    !isNonEmptyString(value.canonicalTool) ||
    !isOptionalString(value, 'personId') ||
    !isOptionalString(value, 'personLabel') ||
    !isNonEmptyString(value.effectHash) ||
    !Number.isInteger(value.effectSchemaVersion) ||
    !Number.isInteger(value.railVersion) ||
    !isOptionalString(value, 'workspaceRoot') ||
    (value.kindVariant !== 'category' && value.kindVariant !== 'tool')
  ) {
    return null;
  }
  return {
    eligible: value.eligible,
    laneInput,
    lane: value.lane,
    appId: value.appId,
    agentFolder: value.agentFolder,
    canonicalTool: value.canonicalTool,
    ...(value.personId !== undefined
      ? { personId: value.personId as string }
      : {}),
    ...(value.personLabel !== undefined
      ? { personLabel: value.personLabel as string }
      : {}),
    effectHash: value.effectHash,
    effectSchemaVersion: value.effectSchemaVersion as number,
    railVersion: value.railVersion as number,
    ...(value.workspaceRoot !== undefined
      ? { workspaceRoot: value.workspaceRoot as string }
      : {}),
    kindVariant: value.kindVariant,
    candidates,
  };
}

export type LearnResult =
  | { status: 'remembered'; id: string }
  | { status: 'not_eligible' }
  | { status: 'not_rememberable'; reason: HumanDecisionServiceRefusal }
  | { status: 'unlearned' };

export async function learnRememberedDecision(input: {
  context: PermissionRememberContext;
  resolution: PermissionRememberResolution;
  service: Pick<HumanDecisionMemoryService, 'rememberDerived'>;
  warn: (context: Record<string, unknown>, message: string) => void;
}): Promise<LearnResult> {
  if (
    !input.context.eligible ||
    input.context.lane !== PermissionLane.InteractiveAuto ||
    deriveAutoLaneAnalysis(input.context.laneInput).lane !==
      PermissionLane.InteractiveAuto
  ) {
    return { status: 'not_eligible' };
  }
  const candidate = rememberCandidate(input.context, input.resolution);
  if (!candidate.ok) {
    return { status: 'not_rememberable', reason: candidate.reason };
  }
  try {
    const result = await input.service.rememberDerived({
      appId: input.context.appId,
      agentFolder: input.context.agentFolder,
      actingPersonId: input.context.personId ?? '',
      ...(input.context.personLabel !== undefined
        ? { actingPersonLabel: input.context.personLabel }
        : {}),
      canonicalTool: input.context.canonicalTool,
      outcome: input.resolution.outcome,
      scope: input.resolution.scope,
      scopeKey: candidate.scopeKey,
      pathOnly: candidate.pathOnly,
      effectHash: input.context.effectHash,
      effectSchemaVersion: input.context.effectSchemaVersion,
      railVersion: input.context.railVersion,
      reason: 'remembered from a card tap',
    });
    return result.status === 'remembered'
      ? { status: 'remembered', id: result.id }
      : result;
  } catch (err) {
    try {
      input.warn(
        {
          err,
          appId: input.context.appId,
          agentFolder: input.context.agentFolder,
        },
        'Failed to learn remembered permission decision',
      );
    } catch {
      // The warning sink must not break the once-only permission result.
    }
    return { status: 'unlearned' };
  }
}

function rememberCandidate(
  context: PermissionRememberContext,
  resolution: PermissionRememberResolution,
): HumanDecisionScopeKeyResult {
  if (resolution.outcome === HumanDecisionOutcome.Deny) {
    return resolution.scope === HumanDecisionScope.Exact
      ? context.candidates.deny
      : refused(HumanDecisionNotRememberableReason.DenyRequiresExact);
  }
  if (resolution.scope === HumanDecisionScope.Exact)
    return context.candidates.exact;
  if (resolution.scope === HumanDecisionScope.Kind) {
    return context.kindVariant === 'tool'
      ? context.candidates.kindTool
      : context.candidates.kind;
  }
  return context.candidates.place;
}

function parseLaneInput(
  value: unknown,
): PermissionRememberContext['laneInput'] | null {
  if (
    !isRecord(value) ||
    (value.permissionMode !== 'ask' &&
      value.permissionMode !== 'auto' &&
      value.permissionMode !== 'auto_strict') ||
    !isOptionalString(value, 'hostJobId')
  ) {
    return null;
  }
  return {
    permissionMode: value.permissionMode,
    ...(value.hostJobId !== undefined
      ? { hostJobId: value.hostJobId as string }
      : {}),
  };
}

function parseCandidates(
  value: unknown,
): PermissionRememberContext['candidates'] | null {
  if (!isRecord(value)) return null;
  const deny = parseCandidate(value.deny);
  const exact = parseCandidate(value.exact);
  const kind = parseCandidate(value.kind);
  const kindTool = parseCandidate(value.kindTool);
  const place = parseCandidate(value.place);
  return deny && exact && kind && kindTool && place
    ? { deny, exact, kind, kindTool, place }
    : null;
}

function parseCandidate(value: unknown): HumanDecisionScopeKeyResult | null {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return null;
  if (value.ok === true) {
    return isNonEmptyString(value.scopeKey) &&
      typeof value.pathOnly === 'boolean'
      ? { ok: true, scopeKey: value.scopeKey, pathOnly: value.pathOnly }
      : null;
  }
  return isNotRememberableReason(value.reason)
    ? { ok: false, reason: value.reason }
    : null;
}

function isPermissionLane(value: unknown): value is PermissionLaneValue {
  return Object.values(PermissionLane).some((lane) => lane === value);
}

function isNotRememberableReason(
  value: unknown,
): value is HumanDecisionNotRememberableReason {
  return Object.values(HumanDecisionNotRememberableReason).some(
    (reason) => reason === value,
  );
}

function isOptionalString(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return value[key] === undefined || typeof value[key] === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function refused(
  reason: HumanDecisionServiceRefusal,
): HumanDecisionScopeKeyResult {
  return { ok: false, reason } as HumanDecisionScopeKeyResult;
}
