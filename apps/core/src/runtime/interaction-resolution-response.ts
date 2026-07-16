import {
  getIpcResponseSigningPrivateKey,
  unsealIpcResponseSigningPrivateKey,
} from './ipc-auth.js';
import {
  writePermissionIpcResponse,
  writeUserQuestionIpcResponse,
} from './ipc-interaction-handler.js';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringRecordValue(
  value: unknown,
): Record<string, string | string[]> | null {
  const raw = objectValue(value);
  if (!raw) return null;
  const out: Record<string, string | string[]> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry === 'string') {
      out[key] = entry;
      continue;
    }
    if (
      Array.isArray(entry) &&
      entry.every((item) => typeof item === 'string')
    ) {
      out[key] = entry;
    }
  }
  return out;
}

export function writeResolvedInteractionResponse(
  payload: Record<string, unknown>,
): boolean {
  const kind = stringValue(payload.kind);
  const requestId = stringValue(payload.requestId);
  const sourceAgentFolder = stringValue(payload.sourceAgentFolder);
  const status = stringValue(payload.status);
  const resolution = objectValue(payload.resolution);
  const callbackRoute = objectValue(payload.callbackRoute);
  const ipcBaseDir = stringValue(callbackRoute?.ipcBaseDir);
  const threadId = stringValue(callbackRoute?.threadId);
  const responseKeyId = stringValue(callbackRoute?.responseKeyId);
  if (!kind || !requestId || !sourceAgentFolder || !ipcBaseDir) return false;
  if (!responseKeyId) return false;
  const privateKey =
    getIpcResponseSigningPrivateKey(
      sourceAgentFolder,
      threadId,
      responseKeyId,
    ) ??
    unsealIpcResponseSigningPrivateKey(
      stringValue(callbackRoute?.responsePrivateKeySeal),
    );
  if (!privateKey) return false;

  if (kind === 'permission') {
    const rawMode = stringValue(resolution?.mode);
    const mode =
      rawMode === 'allow_once' ||
      rawMode === 'allow_persistent_rule' ||
      rawMode === 'cancel'
        ? rawMode
        : 'cancel';
    const approved =
      status !== 'cancelled' &&
      mode !== 'cancel' &&
      resolution?.approved === true;
    writePermissionIpcResponse(
      ipcBaseDir,
      sourceAgentFolder,
      {
        requestId,
        ...(stringValue(callbackRoute?.responseNonce)
          ? { responseNonce: stringValue(callbackRoute?.responseNonce) }
          : {}),
        approved,
        mode,
        ...(stringValue(payload.approverRef)
          ? { decidedBy: stringValue(payload.approverRef) }
          : {}),
        ...(stringValue(resolution?.reason)
          ? { reason: stringValue(resolution?.reason) }
          : {}),
        ...(Array.isArray(resolution?.updatedPermissions)
          ? { updatedPermissions: resolution.updatedPermissions as never }
          : {}),
        ...(stringValue(resolution?.decisionClassification)
          ? {
              decisionClassification: stringValue(
                resolution?.decisionClassification,
              ) as never,
            }
          : {}),
      },
      privateKey,
    );
    return true;
  }

  if (kind === 'question') {
    writeUserQuestionIpcResponse(
      ipcBaseDir,
      sourceAgentFolder,
      {
        requestId,
        answers: stringRecordValue(resolution?.answers) ?? {},
        ...(stringValue(payload.approverRef)
          ? { answeredBy: stringValue(payload.approverRef) }
          : {}),
      },
      privateKey,
    );
    return true;
  }

  return false;
}
