import {
  permissionRiskForDeterministicRailDecision,
  type PermissionDeterministicRailDecision,
} from '../domain/permission-deterministic-rails.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PermissionRiskLevel,
} from '../domain/types.js';
import type { PermissionClassifierPromptConsultResult } from './permission-classifier.js';

/** Shows the more severe of the rail's and the judge's risk on the request. */
export function applyClassifierRisk(
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

export function requestRisk(
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
