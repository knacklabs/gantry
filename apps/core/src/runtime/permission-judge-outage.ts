import {
  createJudgeOutageLatch,
  JUDGE_OFFLINE_REASON,
} from '../application/permissions/permission-judge-outage-latch.js';
import { PermissionClassifierStatus } from '../domain/permission-classifier-status.js';
import { PermissionLane } from '../domain/permission-lane.js';
import type { PermissionDecisionMemoryRepository } from '../domain/ports/permission-decision-memory.js';
import type { PermissionApprovalRequest } from '../domain/types.js';
import {
  EFFECT_SCHEMA_VERSION,
  RAIL_CATALOG_VERSION,
} from '../domain/permission-effect-key.js';
import { gantryNativeCanonicalToolName } from '../application/permissions/gantry-tool-risk.js';
import { logger } from '../infrastructure/logging/logger.js';
import type { PermissionClassifierPromptConsultResult } from './permission-classifier.js';

export const judgeOutageLatch = createJudgeOutageLatch();

type JudgeOutageRequest = Pick<
  PermissionApprovalRequest,
  'appId' | 'providerAccountId' | 'targetJid' | 'sourceAgentFolder' | 'toolName'
>;

/**
 * Records whether the judge answered and returns the reason the prompt shows.
 * An outage is a log line (once per outage per conversation) and a reason on
 * the prompt, never a chat message.
 */
export function observeJudgeAvailability(
  result: PermissionClassifierPromptConsultResult,
  request: JudgeOutageRequest,
): string {
  const { logDue } = judgeOutageLatch.observe(result.status, {
    appId: request.appId ?? 'default',
    providerAccountId: request.providerAccountId,
    targetJid: request.targetJid,
  });
  if (result.status !== PermissionClassifierStatus.Unavailable) {
    return result.reason;
  }
  if (logDue) {
    logger.warn(
      {
        appId: request.appId ?? 'default',
        agentFolder: request.sourceAgentFolder,
        targetJid: request.targetJid,
        toolName: request.toolName,
        failureCode: result.failureCode,
      },
      'Permission safety judge is offline; asking a person',
    );
  }
  return JUDGE_OFFLINE_REASON;
}

/**
 * The verdict cache key: the exact action, agent and conversation (all in the
 * effect hash) plus the lane, so a verdict never crosses a mode or a job.
 */
export function classifierVerdictCacheKey(input: {
  effectHash: string;
  lane: PermissionLane;
}): string {
  return `${input.effectHash}:${input.lane}`;
}

export async function writePermissionClassifierVerdictCache(input: {
  verdict: PermissionClassifierPromptConsultResult;
  lane: PermissionLane;
  request: Pick<
    PermissionApprovalRequest,
    'appId' | 'sourceAgentFolder' | 'toolName'
  >;
  cacheKey: string;
  decisionMemory: PermissionDecisionMemoryRepository;
}): Promise<void> {
  const { verdict, request } = input;
  if (
    verdict.status === PermissionClassifierStatus.Skipped ||
    verdict.status === PermissionClassifierStatus.Unavailable ||
    (verdict.decision === 'allow' &&
      (input.lane === PermissionLane.InteractiveAuto ||
        input.lane === PermissionLane.Autonomous) &&
      (request.toolName === 'FileWrite' ||
        request.toolName === 'FileEdit' ||
        gantryNativeCanonicalToolName(request.toolName) !== null))
  ) {
    return;
  }
  await input.decisionMemory
    .putClassifierVerdict({
      appId: request.appId ?? 'default',
      agentFolder: request.sourceAgentFolder,
      effectHash: input.cacheKey,
      decision: verdict.decision,
      reason: verdict.reason,
      risk_level: verdict.risk_level,
      risk_category: verdict.risk_category,
      effectSchemaVersion: EFFECT_SCHEMA_VERSION,
      railVersion: RAIL_CATALOG_VERSION,
      provenance: 'classifier',
      nowIso: new Date().toISOString(),
    })
    .catch(() => undefined);
}
