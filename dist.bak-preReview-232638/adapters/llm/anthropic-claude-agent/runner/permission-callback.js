import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { nowIso, nowMs, sleep } from '../../../../shared/time/datetime.js';
import { isPlainObject } from '../../../../shared/object.js';
import { persistentPermissionUpdates } from '../../../../shared/permission-tool-rules.js';
import { AUTO_PERMISSION_CLASSIFIER_WAIT_MS } from '../../../../shared/permission-mode.js';
import { NO_PERMISSION_TIMEOUT_MS } from '../../../../shared/permission-timeout.js';
import { writePrivateFileSync } from '../../../../shared/private-fs.js';
import { buildPermissionResponseSignaturePayload, createSignedIpcRequestEnvelope, hasValidIpcResponseSignature, } from '../../../../shared/ipc-signing.js';
import { IPC_CANCELLATION_RETENTION_TTL_MS } from '../../../../shared/ipc-cancellation-lifetime.js';
import { hasIpcRequestClaimMarker, ipcInteractionAuthEnvelopeOptions, ipcInteractionUnclaimableReason, } from '../../../../shared/ipc-interaction-lifetime.js';
import { IPC_AUTH_TOKEN, AGENT_ID, APP_ID, CHAT_JID, JOB_ID, JOB_NAME, JOB_RUN_ID, JOB_RUN_LEASE_FENCING_VERSION, JOB_RUN_LEASE_TOKEN, IPC_RESPONSE_KEY_ID, IPC_RESPONSE_VERIFY_KEY, PERMISSION_LANE, PERMISSION_MODE, PERMISSION_REQUEST_TIMEOUT_MS, PROVIDER_ACCOUNT_ID, SENDER_ID, SENDER_IS_CONTROL_APPROVER, TURN_INTENT_SUMMARY, resolveWorkspaceIpcDir, } from './runtime-env.js';
import { WORKSPACE_FOLDER_OPTION_KEY } from './types.js';
const DEFAULT_RUNNER_APP_ID = 'default';
const AGENT_FOLDER_OPTION_KEY = WORKSPACE_FOLDER_OPTION_KEY;
const UNATTENDED_JOB_PERMISSION_REASON = 'Permission request was sent to the host. Unattended jobs do not wait for approval during the active tool call; approve the requested capability before retrying the scheduled run.';
const UNATTENDED_RUN_PERMISSION_REASON = 'Permission request was sent to the host. Autonomous runs do not wait for approval during the active tool call; approve the requested capability before retrying the run.';
const AUTONOMOUS_PERMISSION_TIMEOUT_REASON = 'Timed out waiting for approval. Retry the autonomous run when an approver is available.';
const INTERACTIVE_PERMISSION_TIMEOUT_REASON = 'Timed out waiting for interactive approval. Retry the live request when an approver is available.';
const CANCELLED_PERMISSION_REASON = 'Permission request cancelled.';
async function sleepWithAbort(ms, signal) {
    if (!signal) {
        await sleep(ms);
        return false;
    }
    if (signal.aborted)
        return true;
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
export async function requestPermissionApproval(options) {
    return requestPermissionApprovalInner({
        ...options,
        appId: options.appId?.trim() || APP_ID || DEFAULT_RUNNER_APP_ID,
        agentId: options.agentId?.trim() || AGENT_ID,
        targetJid: options.targetJid?.trim() || CHAT_JID,
    });
}
async function requestPermissionApprovalInner(options) {
    try {
        const appId = options.appId;
        const agentId = options.agentId;
        const targetJid = options.targetJid;
        const agentFolder = options[AGENT_FOLDER_OPTION_KEY];
        const workspaceIpcDir = resolveWorkspaceIpcDir(agentFolder);
        const permissionRequestsDir = path.join(workspaceIpcDir, 'permission-requests');
        const permissionResponsesDir = path.join(workspaceIpcDir, 'permission-responses');
        fs.mkdirSync(permissionRequestsDir, { recursive: true });
        fs.mkdirSync(permissionResponsesDir, { recursive: true });
        const requestId = `perm-${randomUUID()}`;
        const responseNonce = randomUUID();
        const requestPath = path.join(permissionRequestsDir, `${requestId}.json`);
        const requestTmpPath = `${requestPath}.tmp`;
        const autoClassifierWait = PERMISSION_LANE === 'autonomous' &&
            PERMISSION_REQUEST_TIMEOUT_MS <= NO_PERMISSION_TIMEOUT_MS &&
            PERMISSION_MODE === 'auto';
        const waitMs = autoClassifierWait
            ? AUTO_PERMISSION_CLASSIFIER_WAIT_MS
            : PERMISSION_REQUEST_TIMEOUT_MS;
        const deadline = waitMs > NO_PERMISSION_TIMEOUT_MS ? nowMs() + waitMs : undefined;
        const unboundedInteractive = PERMISSION_LANE === 'interactive' && deadline === undefined;
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
                    semanticCapabilityDefinitions: options.semanticCapabilityDefinitions,
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
            unattended: PERMISSION_LANE === 'autonomous' &&
                PERMISSION_REQUEST_TIMEOUT_MS <= NO_PERMISSION_TIMEOUT_MS,
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
        const envelope = createSignedIpcRequestEnvelope(IPC_AUTH_TOKEN, payload, ipcInteractionAuthEnvelopeOptions(unboundedInteractive));
        const authDeadline = unboundedInteractive
            ? Date.parse(String(envelope.authExpiresAt))
            : undefined;
        writePrivateFileSync(requestTmpPath, JSON.stringify(envelope, null, 2));
        fs.renameSync(requestTmpPath, requestPath);
        if (PERMISSION_LANE === 'autonomous' &&
            PERMISSION_REQUEST_TIMEOUT_MS <= NO_PERMISSION_TIMEOUT_MS &&
            !autoClassifierWait) {
            return {
                approved: false,
                decidedBy: 'runtime',
                reason: unattendedPermissionReason(),
                decisionClassification: 'user_reject',
            };
        }
        const responsePath = path.join(permissionResponsesDir, `${requestId}.json`);
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
                    if (raw &&
                        typeof raw === 'object' &&
                        raw.requestId === requestId) {
                        const responsePayload = buildPermissionResponseSignaturePayload(raw);
                        if (raw.responseNonce !==
                            responseNonce) {
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
                        if (!hasValidIpcResponseSignature(IPC_RESPONSE_VERIFY_KEY, raw)) {
                            return {
                                approved: false,
                                reason: 'Permission response signature verification failed',
                            };
                        }
                        const mode = responsePayload.mode === 'allow_once' ||
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
                        const decisionClassification = responsePayload.decisionClassification === 'user_temporary' ||
                            responsePayload.decisionClassification === 'user_permanent' ||
                            responsePayload.decisionClassification === 'user_reject'
                            ? responsePayload.decisionClassification
                            : undefined;
                        const sanitizedDecision = {
                            approved: responsePayload.approved,
                            mode,
                            decisionClassification,
                            updatedPermissions: Array.isArray(responsePayload.updatedPermissions)
                                ? responsePayload.updatedPermissions
                                : undefined,
                        };
                        return {
                            approved: sanitizedDecision.approved,
                            decidedBy: typeof responsePayload.decidedBy === 'string'
                                ? responsePayload.decidedBy
                                : undefined,
                            reason: typeof responsePayload.reason === 'string'
                                ? responsePayload.reason
                                : undefined,
                            risk_level: isPermissionRiskLevel(responsePayload.risk_level)
                                ? responsePayload.risk_level
                                : undefined,
                            risk_category: isPermissionRiskCategory(responsePayload.risk_category)
                                ? responsePayload.risk_category
                                : undefined,
                            mode,
                            updatedPermissions: persistentPermissionUpdates(sanitizedDecision),
                            decisionClassification,
                        };
                    }
                    return { approved: false, reason: 'Malformed permission response' };
                }
                catch (err) {
                    return {
                        approved: false,
                        reason: err instanceof Error
                            ? err.message
                            : 'Failed to read permission response',
                    };
                }
            }
            if (authDeadline !== undefined && !requestClaimed) {
                requestClaimed = hasIpcRequestClaimMarker(requestPath, options.claimProbe);
                if (!requestClaimed && nowMs() >= authDeadline)
                    break;
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
            reason: PERMISSION_LANE === 'interactive'
                ? INTERACTIVE_PERMISSION_TIMEOUT_REASON
                : PERMISSION_REQUEST_TIMEOUT_MS <= NO_PERMISSION_TIMEOUT_MS
                    ? unattendedPermissionReason()
                    : AUTONOMOUS_PERMISSION_TIMEOUT_REASON,
            decisionClassification: 'user_reject',
        };
    }
    catch (err) {
        return {
            approved: false,
            reason: err instanceof Error
                ? `Permission request failed: ${err.message}`
                : 'Permission request failed',
        };
    }
}
function cancelPermissionRequest(input) {
    try {
        fs.unlinkSync(input.requestPath);
        return;
    }
    catch (err) {
        const code = err && typeof err === 'object' && 'code' in err
            ? String(err.code)
            : '';
        if (code !== 'ENOENT')
            throw err;
    }
    const cancellationsDir = path.join(input.workspaceIpcDir, 'permission-cancellations');
    fs.mkdirSync(cancellationsDir, { recursive: true });
    const cancellationPath = path.join(cancellationsDir, `${input.requestId}.json`);
    if (fs.existsSync(cancellationPath))
        return;
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
function unattendedPermissionReason() {
    return JOB_ID
        ? UNATTENDED_JOB_PERMISSION_REASON
        : UNATTENDED_RUN_PERMISSION_REASON;
}
function isPermissionRiskLevel(value) {
    return (value === 'low' ||
        value === 'medium' ||
        value === 'high' ||
        value === 'critical');
}
function isPermissionRiskCategory(value) {
    return (value === 'destructive' ||
        value === 'privileged' ||
        value === 'secret' ||
        value === 'network' ||
        value === 'filesystem' ||
        value === 'benign');
}
