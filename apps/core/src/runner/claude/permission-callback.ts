import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { nowIso, nowMs, sleep } from '../../shared/time/datetime.js';
import { isPlainObject } from '../../shared/object.js';
import { hasValidIpcResponseSignature } from './ipc-signing.js';
import { createSignedIpcRequestEnvelope } from './ipc-signing.js';
import {
  IPC_AUTH_TOKEN,
  AGENT_ID,
  APP_ID,
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
  blockedPath?: string;
  toolInput?: unknown;
  toolUseID?: string;
  agentID?: string;
  suggestions?: unknown[];
  threadId?: string;
}): Promise<PermissionDecision> {
  try {
    const appId = options.appId?.trim() || APP_ID || DEFAULT_RUNNER_APP_ID;
    const agentId = options.agentId?.trim() || AGENT_ID;
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
      ...(process.env.MYCLAW_AGENT_RUN_HANDLE
        ? { runHandle: process.env.MYCLAW_AGENT_RUN_HANDLE }
        : {}),
      toolName: options.toolName,
      ...(options.title ? { title: options.title } : {}),
      ...(options.displayName ? { displayName: options.displayName } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.decisionReason
        ? { decisionReason: options.decisionReason }
        : {}),
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
            return {
              approved: responsePayload.approved as boolean,
              decidedBy:
                typeof responsePayload.decidedBy === 'string'
                  ? responsePayload.decidedBy
                  : undefined,
              reason:
                typeof responsePayload.reason === 'string'
                  ? responsePayload.reason
                  : undefined,
              mode:
                typeof responsePayload.mode === 'string'
                  ? (responsePayload.mode as never)
                  : undefined,
              updatedPermissions: Array.isArray(
                responsePayload.updatedPermissions,
              )
                ? (responsePayload.updatedPermissions as never)
                : undefined,
              decisionClassification:
                typeof responsePayload.decisionClassification === 'string'
                  ? (responsePayload.decisionClassification as never)
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
      reason: `Timed out waiting ${PERMISSION_REQUEST_TIMEOUT_MS}ms for host permission approval. The host watchdog denied this tool call; retry only if the channel is healthy or request a persistent capability rule.`,
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
