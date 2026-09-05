import type { PermissionClassifierRequestFamily } from '../application/permissions/permission-classifier.js';
import {
  GantryToolRiskVerdict,
  gantryNativeCanonicalToolName,
  gantryToolRisk,
  type GantryToolRisk,
} from '../application/permissions/gantry-tool-risk.js';
import { judgeNativeFileWrite } from '../application/permissions/native-file-write-risk.js';
import {
  PermissionLane,
  type PermissionLane as PermissionLaneValue,
} from '../domain/permission-lane.js';
import { PermissionClassifierStatus } from '../domain/permission-classifier-status.js';
import type { PermissionClassifierResult } from './permission-classifier.js';

export async function evaluateNativeRiskBranch(input: {
  canonicalToolName: string;
  toolInput: unknown;
  workspaceRoot?: string;
  lane?: PermissionLaneValue;
  inputTruncated: boolean;
  yoloDenylistHit: boolean;
  requestFamily: PermissionClassifierRequestFamily;
}): Promise<PermissionClassifierResult | undefined> {
  if (
    input.inputTruncated ||
    input.yoloDenylistHit ||
    input.requestFamily !== 'tool'
  ) {
    return undefined;
  }

  let risk: GantryToolRisk | undefined;
  if (
    input.canonicalToolName === 'FileWrite' ||
    input.canonicalToolName === 'FileEdit'
  ) {
    if (input.lane !== PermissionLane.InteractiveAuto) return undefined;
    risk = await judgeNativeFileWrite({
      toolName: input.canonicalToolName,
      toolInput: input.toolInput,
      workspaceRoot: input.workspaceRoot,
    });
  } else if (gantryNativeCanonicalToolName(input.canonicalToolName) !== null) {
    risk = gantryToolRisk({
      toolName: input.canonicalToolName,
      toolInput: input.toolInput,
    });
  }

  if (
    !risk ||
    risk.verdict === GantryToolRiskVerdict.Ambiguous ||
    (risk.verdict === GantryToolRiskVerdict.Low &&
      input.lane !== PermissionLane.InteractiveAuto)
  ) {
    return undefined;
  }
  return {
    risk_level: risk.verdict,
    reason: risk.reason,
    latencyMs: 0,
    status: PermissionClassifierStatus.Skipped,
  };
}
