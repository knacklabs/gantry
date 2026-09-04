import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { nowIso, nowMs, sleep } from '../../../../shared/time/datetime.js';
import { isPlainObject } from '../../../../shared/object.js';
import { persistentPermissionUpdates } from '../../../../shared/permission-tool-rules.js';
import { NO_PERMISSION_TIMEOUT_MS } from '../../../../shared/permission-timeout.js';
import { writePrivateFileSync } from '../../../../shared/private-fs.js';
import {
  buildPermissionResponseSignaturePayload,
  createSignedIpcRequestEnvelope,
  hasValidIpcResponseSignature,
} from '../../../../shared/ipc-signing.js';
import { IPC_CANCELLATION_RETENTION_TTL_MS } from '../../../../shared/ipc-cancellation-lifetime.js';
import {
  hasIpcRequestClaimMarker,
  ipcInteractionAuthEnvelopeOptions,
  ipcInteractionUnclaimableReason,
  type IpcRequestClaimProbe,
} from '../../../../shared/ipc-interaction-lifetime.js';
import type { SemanticCapabilityDefinition } from '../../../../shared/semantic-capabilities.js';
import type { RailProvenance } from '../../../../domain/permission-lane.js';
import {
  IPC_AUTH_TOKEN,
  AGENT_ID,
  APP_ID,
  CHAT_JID,
  JOB_ID,
  JOB_NAME,
  JOB_RUN_ID,
  JOB_RUN_LEASE_FENCING_VERSION,
  JOB_RUN_LEASE_TOKEN,
  IPC_RESPONSE_KEY_ID,
  IPC_RESPONSE_VERIFY_KEY,
  PERMISSION_LANE,
  PERMISSION_REQUEST_TIMEOUT_MS,
  PROVIDER_ACCOUNT_ID,
  SENDER_ID,
  SENDER_IS_CONTROL_APPROVER,
  TURN_INTENT_SUMMARY,
  resolveWorkspaceIpcDir,
} from './runtime-env.js';
import type { PermissionDecision } from './types.js';
import { WORKSPACE_FOLDER_OPTION_KEY } from './types.js';
import { permissionRequestToolName } from './permission-suggestions.js';

const DEFAULT_RUNNER_APP_ID = 'default';
const AGENT_FOLDER_OPTION_KEY = WORKSPACE_FOLDER_OPTION_KEY;
const PERMISSION_TIMEOUT_REASON =
  'Timed out waiting for approval. Retry the request when an approver is available.';
const CANCELLED_PERMISSION_REASON = 'Permission request cancelled.';
const inFlightPermissionWaits = new Map<string, string>();

export function inFlightPermissionRequests(): {
  count: number;
  toolNames: string[];
} {
  return {
    count: inFlightPermissionWaits.size,
    toolNames: Array.from(new Set(inFlightPermissionWaits.values())).filter(
      Boolean,
    ),
  };
}

async function sleepWithAbort(
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!signal) {
    await sleep(ms);
    return false;
  }
  if (signal.aborted) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
  hostInjectedCommandPrefix?: string;
  toolUseID?: string;
  agentID?: string;
  suggestions?: unknown[];
  decisionOptions?: readonly string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
  targetJid?: string;
  threadId?: string;
  signal?: AbortSignal;
  claimProbe?: IpcRequestClaimProbe;
}): Promise<PermissionDecision> {
  return requestPermissionApprovalInner({
    ...options,
    appId: options.appId?.trim() || APP_ID || DEFAULT_RUNNER_APP_ID,
    agentId: options.agentId?.trim() || AGENT_ID,
    targetJid: options.targetJid?.trim() || CHAT_JID,
  });
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
  hostInjectedCommandPrefix?: string;
  toolUseID?: string;
  agentID?: string;
  suggestions?: unknown[];
  decisionOptions?: readonly string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
  targetJid?: string;
  threadId?: string;
  signal?: AbortSignal;
  claimProbe?: IpcRequestClaimProbe;
}): Promise<PermissionDecision> {
  try {
    const appId = options.appId;
    const agentId = options.agentId;
    const targetJid = options.targetJid;
    const agentFolder = options[AGENT_FOLDER_OPTION_KEY];
    const workspaceIpcDir = resolveWorkspaceIpcDir(agentFolder);
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
    const waitMs = PERMISSION_REQUEST_TIMEOUT_MS;
    const deadline =
      JOB_ID || waitMs <= NO_PERMISSION_TIMEOUT_MS
        ? undefined
        : nowMs() + waitMs;
    const unboundedInteraction = deadline === undefined;
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
      ...(JOB_RUN_LEASE_TOKEN ? { runLeaseToken: JOB_RUN_LEASE_TOKEN } : {}),
      ...(JOB_RUN_LEASE_FENCING_VERSION
        ? { runLeaseFencingVersion: Number(JOB_RUN_LEASE_FENCING_VERSION) }
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
      permissionLane: PERMISSION_LANE,
      ...(deadline !== undefined
        ? {
            expiresAt: new Date(deadline).toISOString(),
          }
        : {}),
      ...(SENDER_ID && SENDER_IS_CONTROL_APPROVER && !JOB_ID
        ? { senderId: SENDER_ID }
        : {}),
      ...(TURN_INTENT_SUMMARY
        ? { turnIntentSummary: TURN_INTENT_SUMMARY.slice(0, 1_500) }
        : {}),
      unattended: PERMISSION_LANE === 'autonomous',
      context: {
        appId,
        ...(agentId ? { agentId } : {}),
        ...(PROVIDER_ACCOUNT_ID
          ? { providerAccountId: PROVIDER_ACCOUNT_ID }
          : {}),
        ...(targetJid ? { chatJid: targetJid } : {}),
        ...(JOB_ID ? { jobId: JOB_ID } : {}),
        ...(JOB_NAME ? { jobName: JOB_NAME } : {}),
        ...(JOB_RUN_ID ? { runId: JOB_RUN_ID } : {}),
        ...(JOB_RUN_LEASE_TOKEN ? { runLeaseToken: JOB_RUN_LEASE_TOKEN } : {}),
        ...(JOB_RUN_LEASE_FENCING_VERSION
          ? { runLeaseFencingVersion: Number(JOB_RUN_LEASE_FENCING_VERSION) }
          : {}),
        ...(options.threadId ? { threadId: options.threadId } : {}),
        ...(IPC_RESPONSE_KEY_ID ? { responseKeyId: IPC_RESPONSE_KEY_ID } : {}),
      },
      timestamp: nowIso(),
    };
    const envelope = createSignedIpcRequestEnvelope(
      IPC_AUTH_TOKEN,
      payload,
      ipcInteractionAuthEnvelopeOptions(unboundedInteraction),
    );
    const authDeadline = unboundedInteraction
      ? Date.parse(String(envelope.authExpiresAt))
      : undefined;
    inFlightPermissionWaits.set(
      requestId,
      permissionRequestToolName(options.toolName),
    );
    try {
      writePrivateFileSync(requestTmpPath, JSON.stringify(envelope, null, 2));
      fs.renameSync(requestTmpPath, requestPath);

      const responsePath = path.join(
        permissionResponsesDir,
        `${requestId}.json`,
      );
      let requestClaimed = false;
      while (deadline === undefined || nowMs() < deadline) {
        if (options.signal?.aborted) {
          cancelPermissionRequest({
            workspaceIpcDir,
            requestPath,
            requestId,
            appId,
            agentId,
            agentFolder,
            threadId: options.threadId,
          });
          return {
            approved: false,
            decidedBy: 'runtime',
            reason: CANCELLED_PERMISSION_REASON,
            decisionClassification: 'user_reject',
          };
        }
        if (fs.existsSync(responsePath)) {
          try {
            const raw = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
            fs.unlinkSync(responsePath);
            if (
              raw &&
              typeof raw === 'object' &&
              (raw as { requestId?: string }).requestId === requestId
            ) {
              const responsePayload =
                buildPermissionResponseSignaturePayload(raw);
              if (
                (raw as { responseNonce?: unknown }).responseNonce !==
                responseNonce
              ) {
                return {
                  approved: false,
                  reason: 'Malformed permission response',
                };
              }
              if (typeof responsePayload.approved !== 'boolean') {
                return {
                  approved: false,
                  reason: 'Malformed permission response',
                };
              }
              if (
                !hasValidIpcResponseSignature(
                  IPC_RESPONSE_VERIFY_KEY,
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
              if (typeof responsePayload.mode === 'string' && !mode) {
                return {
                  approved: false,
                  reason: 'Malformed permission response',
                };
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
                updatedPermissions: Array.isArray(
                  responsePayload.updatedPermissions,
                )
                  ? (responsePayload.updatedPermissions as never)
                  : undefined,
              };
              const railProvenance = decodeRailProvenance(
                responsePayload.railProvenance,
              );
              return {
                approved: sanitizedDecision.approved,
                decidedBy:
                  typeof responsePayload.decidedBy === 'string'
                    ? responsePayload.decidedBy
                    : undefined,
                source: isPermissionDecisionSource(responsePayload.source)
                  ? responsePayload.source
                  : undefined,
                ...(railProvenance ? { railProvenance } : {}),
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
                risk_category: isPermissionRiskCategory(
                  responsePayload.risk_category,
                )
                  ? responsePayload.risk_category
                  : undefined,
                mode,
                updatedPermissions: persistentPermissionUpdates(
                  sanitizedDecision,
                ) as never,
                decisionClassification,
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
        if (authDeadline !== undefined && !requestClaimed) {
          requestClaimed = hasIpcRequestClaimMarker(
            requestPath,
            options.claimProbe,
          );
          if (!requestClaimed && nowMs() >= authDeadline) break;
        }
        const aborted = await sleepWithAbort(100, options.signal);
        if (aborted) {
          cancelPermissionRequest({
            workspaceIpcDir,
            requestPath,
            requestId,
            appId,
            agentId,
            agentFolder,
            threadId: options.threadId,
          });
          return {
            approved: false,
            decidedBy: 'runtime',
            reason: CANCELLED_PERMISSION_REASON,
            decisionClassification: 'user_reject',
          };
        }
      }
      if (authDeadline !== undefined && !requestClaimed) {
        fs.rmSync(requestPath, { force: true });
        return {
          approved: false,
          decidedBy: 'runtime',
          reason: ipcInteractionUnclaimableReason('permission'),
          decisionClassification: 'user_reject',
        };
      }
      return {
        approved: false,
        decidedBy: 'runtime',
        reason: PERMISSION_TIMEOUT_REASON,
        decisionClassification: 'user_reject',
      };
    } finally {
      inFlightPermissionWaits.delete(requestId);
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

function decodeRailProvenance(value: unknown): RailProvenance | undefined {
  if (
    !isPlainObject(value) ||
    !isRailSignal(value.signal) ||
    typeof value.reason !== 'string' ||
    !value.reason.trim()
  ) {
    return undefined;
  }
  return { signal: value.signal, reason: value.reason };
}

function isRailSignal(value: unknown): value is RailProvenance['signal'] {
  return (
    value === 'destructive' ||
    value === 'egress' ||
    value === 'privileged' ||
    value === 'secret_path' ||
    value === 'out_of_trusted_root' ||
    value === 'unsupported_meta_executor'
  );
}

function isPermissionDecisionSource(
  value: unknown,
): value is NonNullable<PermissionDecision['source']> {
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

function cancelPermissionRequest(input: {
  workspaceIpcDir: string;
  requestPath: string;
  requestId: string;
  appId: string;
  agentId?: string;
  agentFolder: string;
  threadId?: string;
}): void {
  try {
    fs.unlinkSync(input.requestPath);
    return;
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: unknown }).code)
        : '';
    if (code !== 'ENOENT') throw err;
  }

  const cancellationsDir = path.join(
    input.workspaceIpcDir,
    'permission-cancellations',
  );
  fs.mkdirSync(cancellationsDir, { recursive: true });
  const cancellationPath = path.join(
    cancellationsDir,
    `${input.requestId}.json`,
  );
  if (fs.existsSync(cancellationPath)) return;
  const cancellationTmpPath = `${cancellationPath}.tmp`;
  const payload = {
    requestId: `perm-cancel-${randomUUID()}`,
    permissionRequestId: input.requestId,
    appId: input.appId,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    sourceAgentFolder: input.agentFolder,
    reason: CANCELLED_PERMISSION_REASON,
    context: {
      appId: input.appId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
    timestamp: nowIso(),
  };
  const envelope = createSignedIpcRequestEnvelope(IPC_AUTH_TOKEN, payload, {
    separateAuthExpiry: true,
    authLifetimeMs: IPC_CANCELLATION_RETENTION_TTL_MS,
    authPurpose: 'cancellation-retention',
  });
  writePrivateFileSync(cancellationTmpPath, JSON.stringify(envelope, null, 2));
  fs.renameSync(cancellationTmpPath, cancellationPath);
}

function isPermissionRiskLevel(
  value: unknown,
): value is NonNullable<PermissionDecision['risk_level']> {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'critical'
  );
}

function isPermissionRiskCategory(
  value: unknown,
): value is NonNullable<PermissionDecision['risk_category']> {
  return (
    value === 'destructive' ||
    value === 'privileged' ||
    value === 'secret' ||
    value === 'network' ||
    value === 'filesystem' ||
    value === 'benign'
  );
}
