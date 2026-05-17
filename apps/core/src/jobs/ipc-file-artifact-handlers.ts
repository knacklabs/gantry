import {
  describeFileArtifact,
  type FileArtifactId,
} from '../domain/file-artifacts/file-artifact.js';
import { isProtectedFileArtifactVirtualPath } from '../domain/file-artifacts/protected-virtual-path.js';
import {
  normalizeFileArtifactPath,
  normalizeFileArtifactScope,
} from '../domain/file-artifacts/virtual-path.js';
import { memoryAgentIdForGroupFolder } from '../memory/app-memory-boundaries.js';
import { sourceAgentHasAdminToolCapability } from './ipc-admin-authorization.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import type { TaskContext, TaskHandler } from './ipc-types.js';

const DEFAULT_READ_LIMIT_BYTES = 64 * 1024;
const MAX_READ_LIMIT_BYTES = 256 * 1024;

function createContextTaskResponder(context: TaskContext) {
  return createTaskResponder(
    context.sourceAgentFolder,
    context.data.taskId,
    context.data.authThreadId,
    context.data.responseKeyId,
  );
}

const fileArtifactHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolder, sourceAgentFolderJids } = context;
  const { acceptData, reject } = createContextTaskResponder(context);
  if (!data.appId) {
    reject('FileArtifact requests require signed app scope.', 'forbidden');
    return;
  }
  const requestedTargetJid = validateSameChannelTarget({
    context,
    sourceAgentFolderJids,
    requestKind: 'FileArtifact',
    reject,
  });
  if (!requestedTargetJid) return;

  const payload = data.payload || {};
  const action = toTrimmedString(payload.action, { maxLen: 32 });
  if (
    action !== 'list' &&
    action !== 'read' &&
    action !== 'write' &&
    action !== 'promote_scratch'
  ) {
    reject('Unsupported FileArtifact action.', 'invalid_request');
    return;
  }

  try {
    const store = context.deps.getFileArtifactStore?.();
    if (!store) {
      reject('FileArtifact storage is not ready.', 'preflight_failed');
      return;
    }
    const owner = {
      appId: data.appId,
      agentId: memoryAgentIdForGroupFolder(sourceAgentFolder),
    };

    if (action === 'list') {
      const artifacts = await store.listFileArtifacts({
        ...owner,
        ...(payload.scope
          ? { virtualScope: normalizeFileArtifactScope(String(payload.scope)) }
          : {}),
        ...(payload.path
          ? { virtualPath: normalizeFileArtifactPath(String(payload.path)) }
          : {}),
        limit: toBoundedLimit(payload.limit, 50, 100),
      });
      acceptData('FileArtifacts listed.', { ok: true, artifacts });
      return;
    }

    if (action === 'read') {
      const artifactId = toTrimmedString(payload.artifactId, { maxLen: 160 });
      const virtualScope = payload.scope
        ? normalizeFileArtifactScope(String(payload.scope))
        : undefined;
      const virtualPath = payload.path
        ? normalizeFileArtifactPath(String(payload.path))
        : undefined;
      if (!artifactId && !virtualPath) {
        reject(
          'FileArtifact read requires artifactId or path.',
          'invalid_request',
        );
        return;
      }
      const result = await store.readFileArtifact({
        ...owner,
        ...(artifactId ? { id: artifactId as FileArtifactId } : {}),
        ...(virtualScope ? { virtualScope } : {}),
        ...(virtualPath ? { virtualPath } : {}),
        ...(typeof payload.version === 'number'
          ? { version: Math.floor(payload.version) }
          : {}),
      });
      acceptData('FileArtifact read.', {
        ok: true,
        artifact: describeFileArtifact(result.artifact),
        content: encodeFileArtifactContent(result.content, {
          offset: typeof payload.offset === 'number' ? payload.offset : 0,
          limit:
            typeof payload.readLimit === 'number'
              ? payload.readLimit
              : DEFAULT_READ_LIMIT_BYTES,
        }),
      });
      return;
    }

    if (action === 'write') {
      const virtualPath = normalizeFileArtifactPath(String(payload.path || ''));
      if (
        !(await authorizeProtectedPromptMutation(context, virtualPath, reject))
      ) {
        return;
      }
      const content = decodeFileArtifactContent(
        payload.content,
        payload.encoding,
      );
      const artifact = await store.writeFileArtifact({
        ...owner,
        virtualScope: normalizeFileArtifactScope(
          String(payload.scope || 'default'),
        ),
        virtualPath,
        content,
        contentType:
          toTrimmedString(payload.contentType, { maxLen: 255 }) ||
          (payload.encoding === 'base64'
            ? 'application/octet-stream'
            : 'text/plain; charset=utf-8'),
        createdBy: `agent:${sourceAgentFolder}`,
      });
      acceptData('FileArtifact written.', {
        ok: true,
        artifact: describeFileArtifact(artifact),
      });
      return;
    }

    const scratchPath = normalizeFileArtifactPath(String(payload.path || ''));
    const targetPath = normalizeFileArtifactPath(
      String(payload.targetPath || ''),
    );
    if (
      !(await authorizeProtectedPromptMutation(context, targetPath, reject))
    ) {
      return;
    }
    const artifact = await store.promoteScratch({
      ...owner,
      scratchPath,
      targetScope: normalizeFileArtifactScope(
        String(payload.targetScope || 'default'),
      ),
      targetPath,
      createdBy: `agent:${sourceAgentFolder}`,
    });
    acceptData('FileArtifact promoted.', {
      ok: true,
      artifact: describeFileArtifact(artifact),
    });
  } catch (err) {
    reject(
      err instanceof Error ? err.message : 'FileArtifact request failed.',
      'invalid_request',
    );
  }
};

export const fileArtifactTaskHandlers: Record<string, TaskHandler> = {
  file_artifact: fileArtifactHandler,
};

function validateSameChannelTarget(input: {
  context: TaskContext;
  sourceAgentFolderJids: string[];
  requestKind: string;
  reject: (error: string, code?: string, details?: string[]) => void;
}): string | null {
  const requestedTargetJid = toTrimmedString(input.context.data.chatJid, {
    maxLen: 512,
  });
  const targetOverride = toTrimmedString(
    input.context.data.targetJid || input.context.data.jid,
    { maxLen: 512 },
  );
  if (targetOverride && targetOverride !== requestedTargetJid) {
    input.reject(
      `${input.requestKind} requests must use the originating chat as the approval target.`,
      'forbidden',
    );
    return null;
  }
  if (
    !requestedTargetJid ||
    !input.sourceAgentFolderJids.includes(requestedTargetJid)
  ) {
    input.reject(
      `${input.requestKind} requests must include the originating chat for this agent.`,
      'forbidden',
    );
    return null;
  }
  return requestedTargetJid;
}

async function authorizeProtectedPromptMutation(
  context: TaskContext,
  virtualPath: string,
  reject: (error: string, code?: string, details?: string[]) => void,
): Promise<boolean> {
  if (!isProtectedPromptPath(virtualPath)) return true;
  const protectedRequested = context.data.payload?.protected === true;
  const authorized =
    protectedRequested &&
    (await sourceAgentHasAdminToolCapability(
      context,
      'request_settings_update',
    ));
  if (authorized) return true;
  reject(
    'Protected prompt FileArtifact mutations require request_settings_update capability and protected=true.',
    'missing_capability',
  );
  return false;
}

function toBoundedLimit(
  value: unknown,
  fallback: number,
  maxLimit: number,
): number {
  const parsed = typeof value === 'number' ? Math.floor(value) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maxLimit);
}

function isProtectedPromptPath(virtualPath: string): boolean {
  return isProtectedFileArtifactVirtualPath(virtualPath);
}

function decodeFileArtifactContent(
  content: unknown,
  encoding: unknown,
): Uint8Array | string {
  if (typeof content !== 'string' || content.length > 2_000_000) {
    throw new Error('FileArtifact write requires content.');
  }
  if (encoding === 'base64') return Buffer.from(content, 'base64');
  return content;
}

function encodeFileArtifactContent(
  content: Uint8Array | string,
  window: { offset: number; limit: number },
):
  | {
      encoding: 'utf8';
      text: string;
      offset: number;
      bytesReturned: number;
      totalBytes: number;
      truncated: boolean;
    }
  | {
      encoding: 'base64';
      data: string;
      offset: number;
      bytesReturned: number;
      totalBytes: number;
      truncated: boolean;
    } {
  const bytes =
    typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  const offset = Math.min(
    Math.max(Math.floor(window.offset), 0),
    bytes.byteLength,
  );
  const limit = Math.min(
    Math.max(Math.floor(window.limit), 1),
    MAX_READ_LIMIT_BYTES,
  );
  const sliced = bytes.subarray(
    offset,
    Math.min(bytes.byteLength, offset + limit),
  );
  const common = {
    offset,
    bytesReturned: sliced.byteLength,
    totalBytes: bytes.byteLength,
    truncated: offset + sliced.byteLength < bytes.byteLength,
  };
  if (typeof content === 'string') {
    return { encoding: 'utf8', text: sliced.toString('utf-8'), ...common };
  }
  return {
    encoding: 'base64',
    data: Buffer.from(sliced).toString('base64'),
    ...common,
  };
}
