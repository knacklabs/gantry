import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';

import { nowIso, nowMs } from '../shared/time/datetime.js';
import { formatDuration } from '../shared/human-format.js';
import {
  buildPermissionResponseSignaturePayload,
  createSignedIpcRequestEnvelope,
  hasValidIpcResponseSignature,
} from '../shared/ipc-signing.js';
import { isPlainObject } from '../shared/object.js';
import { persistentPermissionUpdates } from '../shared/permission-tool-rules.js';
import { NO_PERMISSION_TIMEOUT_MS } from '../shared/permission-timeout.js';
import { ipcInteractionAuthEnvelopeOptions } from '../shared/ipc-interaction-lifetime.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
import type { JobPermissionOutcome } from '../shared/unprojected-access.js';
import {
  DEFAULT_IPC_RESPONSE_POLL_MS,
  waitForIpcResponseFile,
} from './ipc-response-wait.js';

// Provider-neutral file-IPC permission-approval client. Writes a signed
// permission-request JSON under <workspaceIpcDir>/permission-requests/<id>.json
// and waits on <workspaceIpcDir>/permission-responses/ for the host's signed
// decision. The HOST side (apps/core/src/runtime/ipc.ts) watches these dirs and
// creates the durable `pending_interactions` row (idempotency-keyed) BEFORE the
// provider prompt renders — so any runner that writes this file inherits the
// plan's human-in-the-loop durability guarantee. The payload shape mirrors the
// existing host request contract so host-side parsing is unchanged; only the
// env constants are injected here instead of being read from a provider runner
// module, keeping this module reusable across execution adapters.

const DEFAULT_RUNNER_APP_ID = 'default';

export interface PermissionIpcRuntimeEnv {
  appId: string;
  agentId: string;
  chatJid: string;
  providerAccountId?: string;
  jobId: string;
  jobName: string;
  jobRunId: string;
  jobRunLeaseToken: string;
  jobRunLeaseFencingVersion: string;
  ipcAuthToken: string;
  ipcResponseVerifyKey: string;
  ipcResponseKeyId: string;
  agentRunHandle?: string;
  permissionRequestTimeoutMs: number;
  permissionLane?: 'interactive' | 'autonomous';
  permissionMode?: 'ask' | 'auto' | 'auto_strict';
  senderId?: string;
  senderIsControlApprover?: boolean;
  turnIntentSummary?: string;
  resolveWorkspaceIpcDir: (agentFolder: string) => string;
}

export interface PermissionDecisionResult {
  approved: boolean;
  mode?: 'allow_once' | 'allow_persistent_rule' | 'cancel';
  decidedBy?: string;
  source?:
    | 'durable_rule'
    | 'birthright'
    | 'deterministic_policy'
    | 'auto_classifier'
    | 'cached_classifier'
    | 'trusted_root'
    | 'human_once'
    | 'human_persistent';
  repeatableForFutureRuns?: boolean;
  reason?: string;
  risk_level?: 'low' | 'medium' | 'high' | 'critical';
  risk_category?:
    | 'destructive'
    | 'privileged'
    | 'secret'
    | 'network'
    | 'filesystem'
    | 'benign';
  updatedPermissions?: unknown[];
  decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject';
  jobPermissionOutcome?: JobPermissionOutcome;
  unprojectedAccessIdentity?: string;
}

export interface PermissionApprovalRequestOptions {
  appId?: string;
  agentId?: string;
  agentFolder: string;
  toolName: string;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  closestRule?: {
    rule: string;
    reason: string;
  };
  blockedPath?: string;
  toolInput?: unknown;
  hostInjectedCommandPrefix?: string;
  toolUseID?: string;
  agentID?: string;
  suggestions?: unknown[];
  decisionOptions?: readonly string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
  targetJid?: string;
  threadId?: string;
  signal?: AbortSignal;
}

export async function requestPermissionApprovalViaIpc(
  env: PermissionIpcRuntimeEnv,
  options: PermissionApprovalRequestOptions,
): Promise<PermissionDecisionResult> {
  try {
    const appId = options.appId?.trim() || env.appId || DEFAULT_RUNNER_APP_ID;
    const agentId = options.agentId?.trim() || env.agentId;
    const targetJid = options.targetJid?.trim() || env.chatJid;
    const agentFolder = options.agentFolder;
    const permissionLane =
      env.permissionLane === 'interactive' ? 'interactive' : 'autonomous';
    const workspaceIpcDir = env.resolveWorkspaceIpcDir(agentFolder);
    const permissionRequestsDir = path.join(
      workspaceIpcDir,
      'permission-requests',
    );
    const permissionResponsesDir = path.join(
      workspaceIpcDir,
      'permission-responses',
    );
    fs.mkdirSync(permissionRequestsDir, { recursive: true });
    fs.mkdirSync(permissionResponsesDir, { recursive: true });
    const requestId = `perm-${randomUUID()}`;
    const responseNonce = randomUUID();
    const requestPath = path.join(permissionRequestsDir, `${requestId}.json`);
    const requestTmpPath = `${requestPath}.tmp`;
    const waitMs = env.permissionRequestTimeoutMs;
    const deadline =
      env.jobId || waitMs <= NO_PERMISSION_TIMEOUT_MS
        ? undefined
        : nowMs() + waitMs;
    const payload = {
      requestId,
      appId,
      ...(agentId ? { agentId } : {}),
      responseNonce,
      sourceAgentFolder: agentFolder,
      ...(targetJid ? { targetJid } : {}),
      ...(env.agentRunHandle ? { runHandle: env.agentRunHandle } : {}),
      ...(env.jobId ? { jobId: env.jobId } : {}),
      ...(env.jobName ? { jobName: env.jobName } : {}),
      ...(env.jobRunId ? { runId: env.jobRunId } : {}),
      ...(env.jobRunLeaseToken ? { runLeaseToken: env.jobRunLeaseToken } : {}),
      ...(env.jobRunLeaseFencingVersion
        ? { runLeaseFencingVersion: Number(env.jobRunLeaseFencingVersion) }
        : {}),
      toolName: options.toolName,
      ...(options.title ? { title: options.title } : {}),
      ...(options.displayName ? { displayName: options.displayName } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.decisionReason
        ? { decisionReason: options.decisionReason }
        : {}),
      ...(options.closestRule ? { closestRule: options.closestRule } : {}),
      ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
      ...(isPlainObject(options.toolInput)
        ? { toolInput: options.toolInput }
        : {}),
      ...(options.hostInjectedCommandPrefix
        ? {
            hostInjectedCommandPrefix: options.hostInjectedCommandPrefix,
          }
        : {}),
      ...(options.toolUseID ? { toolUseID: options.toolUseID } : {}),
      ...(options.agentID ? { agentID: options.agentID } : {}),
      ...(options.suggestions ? { suggestions: options.suggestions } : {}),
      ...(options.decisionOptions
        ? { decisionOptions: options.decisionOptions }
        : {}),
      ...(options.semanticCapabilityDefinitions
        ? {
            semanticCapabilityDefinitions:
              options.semanticCapabilityDefinitions,
          }
        : {}),
      ...(options.threadId ? { threadId: options.threadId } : {}),
      ...(env.senderId && env.senderIsControlApprover
        ? { senderId: env.senderId }
        : {}),
      ...(env.turnIntentSummary
        ? { turnIntentSummary: env.turnIntentSummary.slice(0, 1_500) }
        : {}),
      permissionLane,
      unattended: permissionLane === 'autonomous',
      context: {
        appId,
        ...(agentId ? { agentId } : {}),
        ...(env.providerAccountId
          ? { providerAccountId: env.providerAccountId }
          : {}),
        ...(targetJid ? { chatJid: targetJid } : {}),
        ...(env.jobId ? { jobId: env.jobId } : {}),
        ...(env.jobName ? { jobName: env.jobName } : {}),
        ...(env.jobRunId ? { runId: env.jobRunId } : {}),
        ...(env.jobRunLeaseToken
          ? { runLeaseToken: env.jobRunLeaseToken }
          : {}),
        ...(env.jobRunLeaseFencingVersion
          ? { runLeaseFencingVersion: Number(env.jobRunLeaseFencingVersion) }
          : {}),
        ...(options.threadId ? { threadId: options.threadId } : {}),
        ...(env.ipcResponseKeyId
          ? { responseKeyId: env.ipcResponseKeyId }
          : {}),
      },
      timestamp: nowIso(),
    };
    const envelope = createSignedIpcRequestEnvelope(
      env.ipcAuthToken,
      payload,
      ipcInteractionAuthEnvelopeOptions(deadline === undefined),
    );
    fs.writeFileSync(requestTmpPath, JSON.stringify(envelope, null, 2));
    fs.renameSync(requestTmpPath, requestPath);

    const responsePath = path.join(permissionResponsesDir, `${requestId}.json`);
    if (
      await waitForPermissionResponse({
        responsePath,
        deadlineMs: deadline,
        ...(options.signal ? { signal: options.signal } : {}),
      })
    ) {
      return readPermissionResponse({
        responsePath,
        requestId,
        responseNonce,
        verifyKey: env.ipcResponseVerifyKey,
      });
    }
    if (options.signal?.aborted) {
      return {
        approved: false,
        reason: 'Permission request cancelled.',
        decisionClassification: 'user_reject',
      };
    }
    return {
      approved: false,
      reason: `Timed out waiting ${formatDuration(waitMs)} for host permission approval. The host watchdog denied this tool call; retry only if the channel is healthy or request a persistent capability rule.`,
      decisionClassification: 'user_reject',
    };
  } catch (err) {
    return {
      approved: false,
      reason:
        err instanceof Error
          ? `Permission request failed: ${err.message}`
          : 'Permission request failed',
    };
  }
}

async function waitForPermissionResponse(input: {
  responsePath: string;
  deadlineMs?: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (!input.signal) {
    return waitForIpcResponseFile({
      responsePath: input.responsePath,
      deadlineMs: input.deadlineMs ?? Number.POSITIVE_INFINITY,
    });
  }
  while (!input.signal.aborted) {
    const startedAt = nowMs();
    if (input.deadlineMs !== undefined && startedAt >= input.deadlineMs) {
      return false;
    }
    const pollDeadline = Math.min(
      input.deadlineMs ?? Number.POSITIVE_INFINITY,
      startedAt + DEFAULT_IPC_RESPONSE_POLL_MS,
    );
    if (
      await waitForIpcResponseFile({
        responsePath: input.responsePath,
        deadlineMs: pollDeadline,
      })
    ) {
      return true;
    }
  }
  return false;
}

function readPermissionResponse(input: {
  responsePath: string;
  requestId: string;
  responseNonce: string;
  verifyKey: string;
}): PermissionDecisionResult {
  try {
    const raw = JSON.parse(fs.readFileSync(input.responsePath, 'utf-8'));
    fs.unlinkSync(input.responsePath);
    if (
      !raw ||
      typeof raw !== 'object' ||
      (raw as { requestId?: string }).requestId !== input.requestId
    ) {
      return { approved: false, reason: 'Malformed permission response' };
    }
    const responsePayload = buildPermissionResponseSignaturePayload(raw);
    if (
      (raw as { responseNonce?: unknown }).responseNonce !== input.responseNonce
    ) {
      return { approved: false, reason: 'Malformed permission response' };
    }
    if (typeof responsePayload.approved !== 'boolean') {
      return { approved: false, reason: 'Malformed permission response' };
    }
    if (
      !hasValidIpcResponseSignature(
        input.verifyKey,
        raw as Record<string, unknown>,
      )
    ) {
      return {
        approved: false,
        reason: 'Permission response signature verification failed',
      };
    }
    const mode =
      responsePayload.mode === 'allow_once' ||
      responsePayload.mode === 'allow_persistent_rule' ||
      responsePayload.mode === 'cancel'
        ? responsePayload.mode
        : undefined;
    if (responsePayload.approved === true && !mode) {
      return { approved: false, reason: 'Malformed permission response' };
    }
    const decisionClassification =
      responsePayload.decisionClassification === 'user_temporary' ||
      responsePayload.decisionClassification === 'user_permanent' ||
      responsePayload.decisionClassification === 'user_reject'
        ? responsePayload.decisionClassification
        : undefined;
    const sanitizedDecision = {
      approved: responsePayload.approved as boolean,
      mode,
      decisionClassification,
      updatedPermissions: Array.isArray(responsePayload.updatedPermissions)
        ? (responsePayload.updatedPermissions as never)
        : undefined,
    };
    const jobPermissionOutcome = permissionOutcome(
      responsePayload.jobPermissionOutcome,
    );
    const unprojectedAccessIdentity =
      typeof responsePayload.unprojectedAccessIdentity === 'string'
        ? responsePayload.unprojectedAccessIdentity.trim().slice(0, 300)
        : undefined;
    if (
      jobPermissionOutcome === 'approved_unprojected' &&
      !unprojectedAccessIdentity
    ) {
      return { approved: false, reason: 'Malformed permission response' };
    }
    return {
      approved: sanitizedDecision.approved,
      decidedBy:
        typeof responsePayload.decidedBy === 'string'
          ? responsePayload.decidedBy
          : undefined,
      source: isPermissionDecisionSource(responsePayload.source)
        ? responsePayload.source
        : undefined,
      repeatableForFutureRuns:
        typeof responsePayload.repeatableForFutureRuns === 'boolean'
          ? responsePayload.repeatableForFutureRuns
          : undefined,
      reason:
        typeof responsePayload.reason === 'string'
          ? responsePayload.reason
          : undefined,
      risk_level: isPermissionRiskLevel(responsePayload.risk_level)
        ? responsePayload.risk_level
        : undefined,
      risk_category: isPermissionRiskCategory(responsePayload.risk_category)
        ? responsePayload.risk_category
        : undefined,
      mode,
      updatedPermissions: persistentPermissionUpdates(
        sanitizedDecision,
      ) as never,
      decisionClassification,
      ...(jobPermissionOutcome ? { jobPermissionOutcome } : {}),
      ...(unprojectedAccessIdentity
        ? { unprojectedAccessIdentity }
        : {}),
    };
  } catch (err) {
    return {
      approved: false,
      reason:
        err instanceof Error
          ? err.message
          : 'Failed to read permission response',
    };
  }
}

function permissionOutcome(value: unknown): JobPermissionOutcome | undefined {
  return value === 'approved' ||
    value === 'approved_unprojected' ||
    value === 'denied' ||
    value === 'policy_changed' ||
    value === 'setup_required'
    ? value
    : undefined;
}

function isPermissionDecisionSource(
  value: unknown,
): value is NonNullable<PermissionDecisionResult['source']> {
  return (
    value === 'durable_rule' ||
    value === 'birthright' ||
    value === 'deterministic_policy' ||
    value === 'auto_classifier' ||
    value === 'cached_classifier' ||
    value === 'trusted_root' ||
    value === 'human_once' ||
    value === 'human_persistent'
  );
}

function isPermissionRiskLevel(
  value: unknown,
): value is NonNullable<PermissionDecisionResult['risk_level']> {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'critical'
  );
}

function isPermissionRiskCategory(
  value: unknown,
): value is NonNullable<PermissionDecisionResult['risk_category']> {
  return (
    value === 'destructive' ||
    value === 'privileged' ||
    value === 'secret' ||
    value === 'network' ||
    value === 'filesystem' ||
    value === 'benign'
  );
}
