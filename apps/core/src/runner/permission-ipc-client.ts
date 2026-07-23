import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';

import { nowIso, nowMs } from '../shared/time/datetime.js';
import { formatDuration } from '../shared/human-format.js';
import {
  createSignedIpcRequestEnvelope,
  hasValidIpcResponseSignature,
} from '../shared/ipc-signing.js';
import { isPlainObject } from '../shared/object.js';
import { persistentPermissionUpdates } from '../shared/permission-tool-rules.js';
import { AUTO_PERMISSION_CLASSIFIER_WAIT_MS } from '../shared/permission-mode.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
import { waitForIpcResponseFile } from './ipc-response-wait.js';

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
  reason?: string;
  updatedPermissions?: unknown[];
  decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject';
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
  toolUseID?: string;
  agentID?: string;
  suggestions?: unknown[];
  decisionOptions?: readonly string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
  targetJid?: string;
  threadId?: string;
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
      unattended: env.permissionRequestTimeoutMs <= 0,
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
    const envelope = createSignedIpcRequestEnvelope(env.ipcAuthToken, payload);
    fs.writeFileSync(requestTmpPath, JSON.stringify(envelope, null, 2));
    fs.renameSync(requestTmpPath, requestPath);

    const autoClassifierWait =
      env.permissionRequestTimeoutMs <= 0 &&
      (env.permissionMode === 'auto' || env.permissionMode === 'auto_strict');
    if (env.permissionRequestTimeoutMs <= 0 && !autoClassifierWait) {
      return {
        approved: false,
        reason:
          'Permission request was sent to the host. Unattended jobs do not wait for approval during the active tool call; approve the requested capability before retrying the scheduled run.',
        decisionClassification: 'user_reject',
      };
    }

    const responsePath = path.join(permissionResponsesDir, `${requestId}.json`);
    const waitMs = autoClassifierWait
      ? AUTO_PERMISSION_CLASSIFIER_WAIT_MS
      : env.permissionRequestTimeoutMs;
    const deadline = nowMs() + waitMs;
    if (await waitForIpcResponseFile({ responsePath, deadlineMs: deadline })) {
      return readPermissionResponse({
        responsePath,
        requestId,
        responseNonce,
        verifyKey: env.ipcResponseVerifyKey,
      });
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
    const responsePayload: Record<string, unknown> = {
      requestId: input.requestId,
      responseNonce: input.responseNonce,
      approved: Boolean((raw as { approved?: unknown }).approved),
      ...(typeof (raw as { mode?: unknown }).mode === 'string'
        ? { mode: (raw as { mode: string }).mode }
        : {}),
      ...(typeof (raw as { decidedBy?: unknown }).decidedBy === 'string'
        ? { decidedBy: (raw as { decidedBy: string }).decidedBy }
        : {}),
      ...(typeof (raw as { reason?: unknown }).reason === 'string'
        ? { reason: (raw as { reason: string }).reason }
        : {}),
      ...(Array.isArray(
        (raw as { updatedPermissions?: unknown }).updatedPermissions,
      )
        ? {
            updatedPermissions: (raw as { updatedPermissions: unknown[] })
              .updatedPermissions,
          }
        : {}),
      ...(typeof (raw as { decisionClassification?: unknown })
        .decisionClassification === 'string'
        ? {
            decisionClassification: (raw as { decisionClassification: string })
              .decisionClassification,
          }
        : {}),
    };
    if (
      (raw as { responseNonce?: unknown }).responseNonce !== input.responseNonce
    ) {
      return { approved: false, reason: 'Malformed permission response' };
    }
    if (
      !hasValidIpcResponseSignature(
        input.verifyKey,
        raw as Record<string, unknown>,
        responsePayload,
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
    return {
      approved: sanitizedDecision.approved,
      decidedBy:
        typeof responsePayload.decidedBy === 'string'
          ? responsePayload.decidedBy
          : undefined,
      reason:
        typeof responsePayload.reason === 'string'
          ? responsePayload.reason
          : undefined,
      mode,
      updatedPermissions: persistentPermissionUpdates(
        sanitizedDecision,
      ) as never,
      decisionClassification,
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
