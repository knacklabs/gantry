import type {
  PermissionApprovalCancellation,
  PermissionApprovalRequest,
  UserQuestionCancellation,
} from '../domain/types.js';
import { IPC_CANCELLATION_RETENTION_TTL_MS } from '../shared/ipc-cancellation-lifetime.js';
import { isPlainObject, toTrimmedString } from '../shared/object.js';
import { validateIpcAuthRequest } from './ipc-auth-validation.js';

const IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function parsePermissionLifecycle(
  raw: Record<string, unknown>,
): Pick<PermissionApprovalRequest, 'permissionLane' | 'expiresAt'> {
  const rawPermissionLane = toTrimmedString(raw.permissionLane, { maxLen: 16 });
  if (
    rawPermissionLane &&
    rawPermissionLane !== 'interactive' &&
    rawPermissionLane !== 'autonomous'
  ) {
    throw new Error('Invalid permission IPC permissionLane');
  }
  const permissionLane =
    rawPermissionLane === 'interactive' || rawPermissionLane === 'autonomous'
      ? rawPermissionLane
      : undefined;
  const expiresAt = toTrimmedString(raw.expiresAt, { maxLen: 128 });
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error('Invalid permission IPC expiresAt');
  }
  return {
    ...(permissionLane ? { permissionLane } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

export function parsePermissionCancellationIpcRequest(
  raw: unknown,
  sourceAgentFolder: string,
): PermissionApprovalCancellation {
  if (!isPlainObject(raw)) {
    throw new Error('Invalid permission cancellation IPC payload');
  }
  const binding = validateIpcAuthRequest(
    raw,
    sourceAgentFolder,
    'permission cancellation IPC',
    {
      extendedAuthPurpose: 'cancellation-retention',
      extendedMaxAgeMs: IPC_CANCELLATION_RETENTION_TTL_MS,
    },
  );
  if (!binding.appId) {
    throw new Error('permission cancellation IPC context.appId is required');
  }
  const requestId = toTrimmedString(raw.permissionRequestId, { maxLen: 128 });
  if (!requestId || !IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid permission cancellation IPC requestId');
  }
  const reason = toTrimmedString(raw.reason, { maxLen: 2000 });
  return {
    requestId,
    appId: binding.appId,
    sourceAgentFolder,
    ...(binding.authThreadId ? { threadId: binding.authThreadId } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function parseQuestionCancellationIpcRequest(
  raw: unknown,
  sourceAgentFolder: string,
): UserQuestionCancellation {
  if (!isPlainObject(raw)) {
    throw new Error('Invalid question cancellation IPC payload');
  }
  const binding = validateIpcAuthRequest(
    raw,
    sourceAgentFolder,
    'question cancellation IPC',
    {
      extendedAuthPurpose: 'cancellation-retention',
      extendedMaxAgeMs: IPC_CANCELLATION_RETENTION_TTL_MS,
    },
  );
  if (!binding.appId) {
    throw new Error('question cancellation IPC context.appId is required');
  }
  const requestId = toTrimmedString(raw.questionRequestId, { maxLen: 128 });
  if (!requestId || !IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid question cancellation IPC requestId');
  }
  const reason = toTrimmedString(raw.reason, { maxLen: 2000 });
  return {
    requestId,
    appId: binding.appId,
    sourceAgentFolder,
    ...(binding.authThreadId ? { threadId: binding.authThreadId } : {}),
    ...(reason ? { reason } : {}),
  };
}
