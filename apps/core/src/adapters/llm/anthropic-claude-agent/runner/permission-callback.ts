import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { nowIso, nowMs, sleep } from '../../../../shared/time/datetime.js';
import { formatDuration } from '../../../../shared/human-format.js';
import { isPlainObject } from '../../../../shared/object.js';
import { persistentPermissionUpdates } from '../../../../shared/permission-tool-rules.js';
import { stableSha256Json } from '../../../../shared/stable-hash.js';
import { hasValidIpcResponseSignature } from './ipc-signing.js';
import { createSignedIpcRequestEnvelope } from './ipc-signing.js';
import type { SemanticCapabilityDefinition } from '../../../../shared/semantic-capabilities.js';
import {
  IPC_AUTH_TOKEN,
  AGENT_ID,
  APP_ID,
  CHAT_JID,
  JOB_ID,
  JOB_NAME,
  JOB_RUN_ID,
  IPC_RESPONSE_KEY_ID,
  PERMISSION_REQUEST_TIMEOUT_MS,
  resolveGroupIpcDir,
} from './runtime-env.js';
import type { PermissionDecision } from './types.js';

const DEFAULT_RUNNER_APP_ID = 'default';
const AGENT_FOLDER_OPTION_KEY = `group${'Folder'}` as const;

const inFlightTimedGrantRequests = new Map<
  string,
  Promise<PermissionDecision>
>();

function timedGrantBatchKey(input: {
  appId: string;
  agentId?: string;
  targetJid?: string;
  agentFolder: string;
  threadId?: string;
  requestFingerprint: string;
}): string {
  return JSON.stringify([
    input.appId,
    input.agentId ?? '',
    input.targetJid ?? '',
    input.agentFolder,
    input.threadId ?? '',
    JOB_ID,
    JOB_RUN_ID,
    input.requestFingerprint,
  ]);
}

function permissionRequestFingerprint(options: {
  toolName: string;
  toolInput?: unknown;
  blockedPath?: string;
  closestRule?: unknown;
  suggestions?: unknown[];
  decisionOptions?: readonly string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}): string {
  return stableSha256Json({
    toolName: options.toolName,
    ...(isPlainObject(options.toolInput)
      ? { toolInput: options.toolInput }
      : {}),
    ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
    ...(options.closestRule ? { closestRule: options.closestRule } : {}),
    ...(options.suggestions ? { suggestions: options.suggestions } : {}),
    ...(options.decisionOptions
      ? { decisionOptions: options.decisionOptions }
      : {}),
    ...(options.semanticCapabilityDefinitions
      ? { semanticCapabilityDefinitions: options.semanticCapabilityDefinitions }
      : {}),
  });
}

function canSharePermissionDecision(decision: PermissionDecision): boolean {
  return decision.mode === 'allow_timed_grant';
}

export async function requestPermissionApproval(options: {
  appId?: string;
  agentId?: string;
  [AGENT_FOLDER_OPTION_KEY]: string;
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
}): Promise<PermissionDecision> {
  try {
    const appId = options.appId?.trim() || APP_ID || DEFAULT_RUNNER_APP_ID;
    const agentId = options.agentId?.trim() || AGENT_ID;
    const targetJid = options.targetJid?.trim() || CHAT_JID;
    const agentFolder = options[AGENT_FOLDER_OPTION_KEY];
    const requestFingerprint = permissionRequestFingerprint(options);
    const batchKey = timedGrantBatchKey({
      appId,
      agentId,
      targetJid,
      agentFolder,
      threadId: options.threadId,
      requestFingerprint,
    });
    const existingRequest = inFlightTimedGrantRequests.get(batchKey);
    if (existingRequest) {
      const sharedDecision = await existingRequest;
      if (canSharePermissionDecision(sharedDecision)) {
        return sharedDecision;
      }
    }
    const currentRequest = requestPermissionApprovalInner({
      ...options,
      appId,
      agentId,
      targetJid,
    });
    inFlightTimedGrantRequests.set(batchKey, currentRequest);
    try {
      return await currentRequest;
    } finally {
      if (inFlightTimedGrantRequests.get(batchKey) === currentRequest) {
        inFlightTimedGrantRequests.delete(batchKey);
      }
    }
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

async function requestPermissionApprovalInner(options: {
  appId: string;
  agentId?: string;
  [AGENT_FOLDER_OPTION_KEY]: string;
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
}): Promise<PermissionDecision> {
  try {
    const appId = options.appId;
    const agentId = options.agentId;
    const targetJid = options.targetJid;
    const agentFolder = options[AGENT_FOLDER_OPTION_KEY];
    const groupIpcDir = resolveGroupIpcDir(agentFolder);
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
      sourceAgentFolder: agentFolder,
      ...(targetJid ? { targetJid } : {}),
      ...(process.env.GANTRY_AGENT_RUN_HANDLE
        ? { runHandle: process.env.GANTRY_AGENT_RUN_HANDLE }
        : {}),
      ...(JOB_ID ? { jobId: JOB_ID } : {}),
      ...(JOB_NAME ? { jobName: JOB_NAME } : {}),
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
      context: {
        appId,
        ...(agentId ? { agentId } : {}),
        ...(targetJid ? { chatJid: targetJid } : {}),
        ...(JOB_ID ? { jobId: JOB_ID } : {}),
        ...(JOB_NAME ? { jobName: JOB_NAME } : {}),
        ...(JOB_RUN_ID ? { runId: JOB_RUN_ID } : {}),
        ...(options.threadId ? { threadId: options.threadId } : {}),
        ...(IPC_RESPONSE_KEY_ID ? { responseKeyId: IPC_RESPONSE_KEY_ID } : {}),
      },
      timestamp: nowIso(),
    };
    const envelope = createSignedIpcRequestEnvelope(IPC_AUTH_TOKEN, payload);
    fs.writeFileSync(requestTmpPath, JSON.stringify(envelope, null, 2));
    fs.renameSync(requestTmpPath, requestPath);

    if (PERMISSION_REQUEST_TIMEOUT_MS <= 0) {
      return {
        approved: false,
        reason:
          'Permission request was sent to the host. Unattended jobs do not wait for approval during the active tool call; approve the requested capability before retrying the scheduled run.',
        decisionClassification: 'user_reject',
      };
    }

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
