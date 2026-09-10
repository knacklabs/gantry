import {
  createJudgeOutageLatch,
  JUDGE_OFFLINE_NOTICE,
  JUDGE_OFFLINE_REASON,
} from '../application/permissions/permission-judge-outage-latch.js';
import { PermissionClassifierStatus } from '../domain/permission-classifier-status.js';
import { PermissionLane } from '../domain/permission-lane.js';
import type { PermissionDecisionMemoryRepository } from '../domain/ports/permission-decision-memory.js';
import type {
  MessageSendOptions,
  PermissionApprovalRequest,
} from '../domain/types.js';
import {
  EFFECT_SCHEMA_VERSION,
  RAIL_CATALOG_VERSION,
} from '../domain/permission-effect-key.js';
import { gantryNativeCanonicalToolName } from '../application/permissions/gantry-tool-risk.js';
import type { PermissionClassifierPromptConsultResult } from './permission-classifier.js';

export const judgeOutageLatch = createJudgeOutageLatch();

export function isJudgeUnavailable(
  result: PermissionClassifierPromptConsultResult | undefined,
): boolean {
  return result?.status === PermissionClassifierStatus.Unavailable;
}

export function judgeOutageReason(
  result: PermissionClassifierPromptConsultResult,
): string {
  return isJudgeUnavailable(result) ? JUDGE_OFFLINE_REASON : result.reason;
}

type JudgeOutageRequest = Pick<
  PermissionApprovalRequest,
  'appId' | 'providerAccountId' | 'targetJid' | 'threadId'
>;

function keyForRequest(request: JudgeOutageRequest) {
  return {
    appId: request.appId ?? 'default',
    providerAccountId: request.providerAccountId,
    targetJid: request.targetJid,
  };
}

export async function sendJudgeOfflineNoticeForRequest(
  result: PermissionClassifierPromptConsultResult | undefined,
  sendMessage:
    | ((
        jid: string,
        text: string,
        options?: MessageSendOptions,
      ) => Promise<unknown>)
    | undefined,
  request: JudgeOutageRequest,
): Promise<void> {
  if (!result) return;
  const { noticeDue } = judgeOutageLatch.observe(
    result.status,
    keyForRequest(request),
  );
  if (
    !isJudgeUnavailable(result) ||
    !noticeDue ||
    !request.targetJid ||
    !sendMessage
  )
    return;
  await sendMessage(request.targetJid, JUDGE_OFFLINE_NOTICE, {
    threadId: request.threadId,
    providerAccountId: request.providerAccountId,
  }).catch(() => undefined);
}

export function observeJudgeAvailabilityForRequest(
  result: PermissionClassifierPromptConsultResult | undefined,
  request: JudgeOutageRequest,
): void {
  if (result) judgeOutageLatch.observe(result.status, keyForRequest(request));
}

export async function writePermissionClassifierVerdictCache(input: {
  classifierDecision: PermissionClassifierPromptConsultResult | undefined;
  lane: PermissionLane;
  hostJobId?: string;
  toolName: string;
  effectHash?: string;
  decisionMemory?: PermissionDecisionMemoryRepository;
  railRequiresApproval: boolean;
  appId?: string;
  agentFolder: string;
}): Promise<void> {
  const decision = input.classifierDecision;
  if (
    !decision ||
    decision.status === PermissionClassifierStatus.Skipped ||
    decision.status === PermissionClassifierStatus.Unavailable ||
    (decision.decision === 'allow' &&
      (input.lane === PermissionLane.InteractiveAuto || input.hostJobId) &&
      (input.toolName === 'FileWrite' ||
        input.toolName === 'FileEdit' ||
        gantryNativeCanonicalToolName(input.toolName) !== null)) ||
    input.railRequiresApproval ||
    !input.effectHash ||
    !input.decisionMemory
  ) {
    return;
  }
  await input.decisionMemory
    .putClassifierVerdict({
      appId: input.appId ?? 'default',
      agentFolder: input.agentFolder,
      effectHash: input.effectHash,
      decision: decision.decision,
      reason: decision.reason,
      risk_level: decision.risk_level,
      risk_category: decision.risk_category,
      effectSchemaVersion: EFFECT_SCHEMA_VERSION,
      railVersion: RAIL_CATALOG_VERSION,
      provenance: 'classifier',
      nowIso: new Date().toISOString(),
    })
    .catch(() => undefined);
}
