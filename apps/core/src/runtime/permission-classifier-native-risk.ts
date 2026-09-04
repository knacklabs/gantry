import type { PermissionClassifierRequestFamily } from '../application/permissions/permission-classifier.js';
import { gantryToolDefaultRisk } from '../application/permissions/gantry-tool-risk.js';
import { PermissionClassifierStatus } from '../domain/permission-classifier-status.js';
import type { PermissionClassifierResult } from './permission-classifier.js';

export function evaluateNativeRiskBranch(input: {
  canonicalToolName: string;
  inputTruncated: boolean;
  yoloDenylistHit: boolean;
  requestFamily: PermissionClassifierRequestFamily;
}): PermissionClassifierResult | undefined {
  if (
    input.inputTruncated ||
    input.yoloDenylistHit ||
    input.requestFamily !== 'tool'
  ) {
    return undefined;
  }
  const risk = gantryToolDefaultRisk(input.canonicalToolName);
  return risk
    ? {
        risk_level: risk.risk_level,
        reason: risk.reason,
        latencyMs: 0,
        status: PermissionClassifierStatus.Skipped,
      }
    : undefined;
}
