import { isHumanDecisionId } from '../shared/human-decision-id.js';
import {
  HumanDecisionOutcome,
  HumanDecisionScope,
} from './ports/permission-decision-memory.js';
import type {
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
} from './types.js';

export { HumanDecisionOutcome, HumanDecisionScope };

export interface PermissionRememberResolution {
  kind: 'remember';
  outcome: HumanDecisionOutcome;
  scope: HumanDecisionScope;
}

export type PermissionApprovalResolution =
  | { kind: 'mode'; mode: PermissionApprovalDecisionMode }
  | PermissionRememberResolution;

export function isRememberResolution(
  resolution: PermissionApprovalResolution,
): resolution is PermissionRememberResolution {
  return resolution.kind === 'remember';
}

export function resolutionMode(
  resolution: PermissionApprovalResolution,
): PermissionApprovalDecisionMode | undefined {
  return resolution.kind === 'mode' ? resolution.mode : undefined;
}

export interface HumanDecisionRememberRequest {
  appId: string;
  agentFolder: string;
  actingPersonId: string;
  actingPersonLabel?: string;
  resolution: PermissionApprovalResolution;
  request: PermissionApprovalRequest;
  effectHash?: string;
  workspaceRoot?: string;
  canonicalRoot?: string;
  trustGrowthTool?: boolean;
  railVersion: number;
  effectSchemaVersion: number;
  reason: string;
}

export interface HumanDecisionProvenance {
  id: string;
  actingPersonId: string;
  outcome: HumanDecisionOutcome;
  scope: HumanDecisionScope;
  railVersion: number;
}

const HUMAN_DECISION_PROVENANCE_PREFIX = 'human_decision:';

export function encodeHumanDecisionProvenance(
  input: HumanDecisionProvenance,
): string {
  return `${HUMAN_DECISION_PROVENANCE_PREFIX}${JSON.stringify({
    actingPersonId: input.actingPersonId,
    id: input.id,
    outcome: input.outcome,
    railVersion: input.railVersion,
    scope: input.scope,
  })}`;
}

export function decodeHumanDecisionProvenance(
  text: string,
): HumanDecisionProvenance | undefined {
  if (!text.startsWith(HUMAN_DECISION_PROVENANCE_PREFIX)) return undefined;
  try {
    const value: unknown = JSON.parse(
      text.slice(HUMAN_DECISION_PROVENANCE_PREFIX.length),
    );
    if (!isRecord(value)) return undefined;
    if (
      !isHumanDecisionId(value.id) ||
      typeof value.actingPersonId !== 'string' ||
      !value.actingPersonId.trim() ||
      (value.outcome !== HumanDecisionOutcome.Allow &&
        value.outcome !== HumanDecisionOutcome.Deny) ||
      (value.scope !== HumanDecisionScope.Exact &&
        value.scope !== HumanDecisionScope.Kind &&
        value.scope !== HumanDecisionScope.Place) ||
      typeof value.railVersion !== 'number' ||
      !Number.isInteger(value.railVersion)
    ) {
      return undefined;
    }
    return {
      id: value.id,
      actingPersonId: value.actingPersonId,
      outcome: value.outcome,
      scope: value.scope,
      railVersion: value.railVersion,
    };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
