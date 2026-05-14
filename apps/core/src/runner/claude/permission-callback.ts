import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { nowIso, nowMs, sleep } from '../../shared/time/datetime.js';
import { formatDuration } from '../../shared/human-format.js';
import { isPlainObject } from '../../shared/object.js';
import { persistentPermissionUpdates } from '../../shared/permission-tool-rules.js';
import { hasValidIpcResponseSignature } from './ipc-signing.js';
import { createSignedIpcRequestEnvelope } from './ipc-signing.js';
import {
  IPC_AUTH_TOKEN,
  AGENT_ID,
  APP_ID,
  CHAT_JID,
  JOB_ID,
  JOB_RUN_ID,
  IPC_RESPONSE_KEY_ID,
  PERMISSION_REQUEST_TIMEOUT_MS,
  resolveGroupIpcDir,
} from './runtime-env.js';
import type { PermissionDecision } from './types.js';

const DEFAULT_RUNNER_APP_ID = 'default';

export async function requestPermissionApproval(options: {
  appId?: string;
  agentId?: string;
  groupFolder: string;
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
  targetJid?: string;
  threadId?: string;
}): Promise<PermissionDecision> {
  try {
    const appId = options.appId?.trim() || APP_ID || DEFAULT_RUNNER_APP_ID;
    const agentId = options.agentId?.trim() || AGENT_ID;
    const targetJid = options.targetJid?.trim() || CHAT_JID;
    if (PERMISSION_REQUEST_TIMEOUT_MS <= 0) {
      return {
        approved: false,
        reason:
          'Autonomous permission approval is disabled for unattended jobs. The host denied this tool call immediately; approve a persistent capability rule before the next scheduled run.',
        decisionClassification: 'user_reject',
      };
    }
    const groupIpcDir = resolveGroupIpcDir(options.groupFolder);
    const permissionRequestsDir = path.join(groupIpcDir, 'permission-requests');
    const permissionResponsesDir = path.join(
      groupIpcDir,
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
      sourceAgentFolder: options.groupFolder,
      ...(targetJid ? { targetJid } : {}),
      ...(process.env.MYCLAW_AGENT_RUN_HANDLE
        ? { runHandle: process.env.MYCLAW_AGENT_RUN_HANDLE }
        : {}),
      ...(JOB_ID ? { jobId: JOB_ID } : {}),
      ...(JOB_RUN_ID ? { runId: JOB_RUN_ID } : {}),
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
      ...(options.threadId ? { threadId: options.threadId } : {}),
      context: {
        appId,
        ...(agentId ? { agentId } : {}),
        ...(targetJid ? { chatJid: targetJid } : {}),
        ...(JOB_ID ? { jobId: JOB_ID } : {}),
        ...(JOB_RUN_ID ? { runId: JOB_RUN_ID } : {}),
        ...(options.threadId ? { threadId: options.threadId } : {}),
        ...(IPC_RESPONSE_KEY_ID ? { responseKeyId: IPC_RESPONSE_KEY_ID } : {}),
      },
      timestamp: nowIso(),
    };
    const envelope = createSignedIpcRequestEnvelope(IPC_AUTH_TOKEN, payload);
    fs.writeFileSync(requestTmpPath, JSON.stringify(envelope, null, 2));
    fs.renameSync(requestTmpPath, requestPath);

    const responsePath = path.join(permissionResponsesDir, `${requestId}.json`);
    const deadline = nowMs() + PERMISSION_REQUEST_TIMEOUT_MS;
    while (nowMs() < deadline) {
      if (fs.existsSync(responsePath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
          fs.unlinkSync(responsePath);
          if (
            raw &&
            typeof raw === 'object' &&
            (raw as { requestId?: string }).requestId === requestId
          ) {
            const responsePayload: Record<string, unknown> = {
              requestId,
              responseNonce,
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
                    updatedPermissions: (
                      raw as { updatedPermissions: unknown[] }
                    ).updatedPermissions,
                  }
                : {}),
              ...(typeof (raw as { decisionClassification?: unknown })
                .decisionClassification === 'string'
                ? {
                    decisionClassification: (
                      raw as { decisionClassification: string }
                    ).decisionClassification,
                  }
                : {}),
              ...(typeof (raw as { timedGrantExpiresAtMs?: unknown })
                .timedGrantExpiresAtMs === 'number'
                ? {
                    timedGrantExpiresAtMs: (
                      raw as { timedGrantExpiresAtMs: number }
                    ).timedGrantExpiresAtMs,
                  }
                : {}),
            };
            if (
              (raw as { responseNonce?: unknown }).responseNonce !==
              responseNonce
            ) {
              return {
                approved: false,
                reason: 'Malformed permission response',
              };
            }
            if (
              !hasValidIpcResponseSignature(
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
              responsePayload.mode === 'allow_timed_grant' ||
              responsePayload.mode === 'cancel'
                ? responsePayload.mode
                : undefined;
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
              updatedPermissions: Array.isArray(
                responsePayload.updatedPermissions,
              )
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
              timedGrantExpiresAtMs:
                typeof responsePayload.timedGrantExpiresAtMs === 'number'
                  ? (responsePayload.timedGrantExpiresAtMs as number)
                  : undefined,
            };
          }
          return { approved: false, reason: 'Malformed permission response' };
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
      await sleep(100);
    }
    return {
      approved: false,
      reason: `Timed out waiting ${formatDuration(PERMISSION_REQUEST_TIMEOUT_MS)} for host permission approval. The host watchdog denied this tool call; retry only if the channel is healthy or request a persistent capability rule.`,
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
