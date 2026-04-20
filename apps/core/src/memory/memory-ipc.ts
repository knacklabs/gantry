import fs from 'fs';
import path from 'path';
import { MemoryIpcRequest, MemoryIpcResponse } from '@myclaw/contracts';

import { logger } from '../core/logger.js';
import { resolveGroupIpcPath } from '../platform/group-folder.js';
import { MemoryService } from './memory-service.js';
import {
  PatchMemoryInput,
  PatchProcedureInput,
  SaveMemoryInput,
  SaveProcedureInput,
} from './memory-types.js';

const MEMORY_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOptionalString(
  value: unknown,
  opts: { maxLen?: number } = {},
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (opts.maxLen && trimmed.length > opts.maxLen) return undefined;
  return trimmed;
}

function parseOptionalNumber(
  value: unknown,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (opts.min !== undefined && value < opts.min) return undefined;
  if (opts.max !== undefined && value > opts.max) return undefined;
  return value;
}

function parseOptionalTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const parsed = parseOptionalString(item, { maxLen: 64 });
    if (!parsed) return undefined;
    out.push(parsed);
  }
  return out;
}

function parseMemoryScope(
  value: unknown,
): SaveMemoryInput['scope'] | SaveProcedureInput['scope'] | undefined {
  const scope = parseOptionalString(value, { maxLen: 16 });
  if (scope === 'user' || scope === 'group' || scope === 'global') return scope;
  return undefined;
}

function parseMemoryKind(value: unknown): SaveMemoryInput['kind'] | undefined {
  const kind = parseOptionalString(value, { maxLen: 32 });
  if (
    kind === 'preference' ||
    kind === 'decision' ||
    kind === 'fact' ||
    kind === 'correction' ||
    kind === 'constraint'
  ) {
    return kind;
  }
  return undefined;
}

function parseSaveMemoryInput(payload: unknown): SaveMemoryInput {
  if (!isPlainObject(payload)) {
    throw new Error('memory_save payload must be an object');
  }
  const key = parseOptionalString(payload.key, { maxLen: 256 });
  const value = parseOptionalString(payload.value, { maxLen: 10_000 });
  if (!key || !value) {
    throw new Error('memory_save requires key and value');
  }
  const scope = parseMemoryScope(payload.scope);
  const kind = parseMemoryKind(payload.kind);
  const groupFolder = parseOptionalString(payload.group_folder, {
    maxLen: 128,
  });
  const userId = parseOptionalString(payload.user_id, { maxLen: 255 });
  const confidence = parseOptionalNumber(payload.confidence, {
    min: 0,
    max: 1,
  });
  const why = parseOptionalString(payload.why, { maxLen: 500 });
  const sourceTurnId = parseOptionalString(payload.source_turn_id, {
    maxLen: 255,
  });
  const loadBearing =
    typeof payload.load_bearing === 'boolean'
      ? payload.load_bearing
      : undefined;
  const source = parseOptionalString(payload.source, { maxLen: 255 });
  const supersedes = Array.isArray(payload.supersedes)
    ? payload.supersedes
        .map((entry) => parseOptionalString(entry, { maxLen: 128 }))
        .filter((entry): entry is string => Boolean(entry))
    : undefined;
  return {
    key,
    value,
    ...(scope ? { scope } : {}),
    ...(kind ? { kind } : {}),
    ...(groupFolder ? { group_folder: groupFolder } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(why ? { why } : {}),
    ...(sourceTurnId ? { source_turn_id: sourceTurnId } : {}),
    ...(loadBearing !== undefined ? { load_bearing: loadBearing } : {}),
    ...(supersedes && supersedes.length > 0 ? { supersedes } : {}),
    ...(source ? { source } : {}),
  };
}

function parsePatchMemoryInput(payload: unknown): PatchMemoryInput {
  if (!isPlainObject(payload)) {
    throw new Error('memory_patch payload must be an object');
  }
  const id = parseOptionalString(payload.id, { maxLen: 128 });
  const expectedVersion = parseOptionalNumber(payload.expected_version, {
    min: 1,
  });
  if (!id || expectedVersion === undefined) {
    throw new Error('memory_patch requires id and expected_version');
  }
  const key = parseOptionalString(payload.key, { maxLen: 256 });
  const value = parseOptionalString(payload.value, { maxLen: 10_000 });
  const confidence = parseOptionalNumber(payload.confidence, {
    min: 0,
    max: 1,
  });
  const why = parseOptionalString(payload.why, { maxLen: 500 });
  const loadBearing =
    typeof payload.load_bearing === 'boolean'
      ? payload.load_bearing
      : undefined;
  return {
    id,
    expected_version: Math.round(expectedVersion),
    ...(key ? { key } : {}),
    ...(value ? { value } : {}),
    ...(why ? { why } : {}),
    ...(loadBearing !== undefined ? { load_bearing: loadBearing } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

function assertValidRequestId(requestId: string): void {
  if (!MEMORY_IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid memory IPC requestId');
  }
}

function parseSaveProcedureInput(payload: unknown): SaveProcedureInput {
  if (!isPlainObject(payload)) {
    throw new Error('procedure_save payload must be an object');
  }
  const title = parseOptionalString(payload.title, { maxLen: 256 });
  const body = parseOptionalString(payload.body, { maxLen: 50_000 });
  if (!title || !body) {
    throw new Error('procedure_save requires title and body');
  }
  const scope = parseMemoryScope(payload.scope);
  const groupFolder = parseOptionalString(payload.group_folder, {
    maxLen: 128,
  });
  const tags = parseOptionalTags(payload.tags);
  const originRaw = parseOptionalString(payload.origin, { maxLen: 64 });
  const origin =
    originRaw === 'explicit' || originRaw === 'accepted_suggestion'
      ? originRaw
      : undefined;
  const trigger = parseOptionalString(payload.trigger, { maxLen: 280 });
  const confidence = parseOptionalNumber(payload.confidence, {
    min: 0,
    max: 1,
  });
  const source = parseOptionalString(payload.source, { maxLen: 255 });
  return {
    title,
    body,
    ...(scope ? { scope } : {}),
    ...(groupFolder ? { group_folder: groupFolder } : {}),
    ...(tags ? { tags } : {}),
    ...(origin ? { origin } : {}),
    ...(trigger ? { trigger } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(source ? { source } : {}),
  };
}

function parsePatchProcedureInput(payload: unknown): PatchProcedureInput {
  if (!isPlainObject(payload)) {
    throw new Error('procedure_patch payload must be an object');
  }
  const id = parseOptionalString(payload.id, { maxLen: 128 });
  const expectedVersion = parseOptionalNumber(payload.expected_version, {
    min: 1,
  });
  if (!id || expectedVersion === undefined) {
    throw new Error('procedure_patch requires id and expected_version');
  }
  const title = parseOptionalString(payload.title, { maxLen: 256 });
  const body = parseOptionalString(payload.body, { maxLen: 50_000 });
  const tags = parseOptionalTags(payload.tags);
  const trigger =
    payload.trigger === null
      ? null
      : parseOptionalString(payload.trigger, { maxLen: 280 });
  const confidence = parseOptionalNumber(payload.confidence, {
    min: 0,
    max: 1,
  });
  return {
    id,
    expected_version: Math.round(expectedVersion),
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
    ...(tags ? { tags } : {}),
    ...(trigger !== undefined ? { trigger } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

export async function processMemoryRequest(
  request: MemoryIpcRequest,
  sourceGroup: string,
  isMain: boolean,
): Promise<MemoryIpcResponse> {
  let provider = 'uninitialized';

  try {
    assertValidRequestId(request.requestId);
    const memory = MemoryService.getInstance();
    provider = memory.getProviderName();
    logger.debug(
      { action: request.action, sourceGroup, isMain, provider },
      'Processing memory IPC request',
    );

    switch (request.action) {
      case 'memory_search': {
        const query = String(request.payload.query || '').trim();
        if (!query) {
          throw new Error('query is required');
        }
        // IPC memory reads are always scoped to the source group to prevent
        // cross-group data access from agent processes.
        const groupFolder = sourceGroup;
        const results = await memory.search({
          query,
          groupFolder,
          userId: request.payload.user_id
            ? String(request.payload.user_id)
            : undefined,
          limit: request.payload.limit
            ? Number(request.payload.limit)
            : undefined,
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { results },
        };
      }
      case 'memory_save': {
        const input = parseSaveMemoryInput(request.payload);
        const saved = await memory.saveMemory(input, {
          isMain,
          groupFolder: sourceGroup,
          actor: 'mcp-tool',
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { memory: saved },
        };
      }
      case 'memory_patch': {
        const input = parsePatchMemoryInput(request.payload);
        const patched = memory.patchMemory(input, {
          isMain,
          groupFolder: sourceGroup,
          actor: 'mcp-tool',
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { memory: patched },
        };
      }
      case 'memory_consolidate': {
        const groupFolder = sourceGroup;
        const result = await memory.consolidateGroupMemory(groupFolder);
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { consolidation: result },
        };
      }
      case 'memory_dream': {
        const groupFolder = sourceGroup;
        const result = await memory.runDreamingSweep(groupFolder);
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { dreaming: result },
        };
      }
      case 'procedure_save': {
        const input = parseSaveProcedureInput(request.payload);
        const saved = memory.saveProcedure(input, {
          isMain,
          groupFolder: sourceGroup,
          actor: 'mcp-tool',
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { procedure: saved },
        };
      }
      case 'procedure_patch': {
        const input = parsePatchProcedureInput(request.payload);
        const patched = memory.patchProcedure(input, {
          isMain,
          groupFolder: sourceGroup,
          actor: 'mcp-tool',
        });
        return {
          ok: true,
          requestId: request.requestId,
          provider,
          data: { procedure: patched },
        };
      }
      default:
        throw new Error(
          `Unsupported memory action: ${(request as { action?: string }).action || 'unknown'}`,
        );
    }
  } catch (err) {
    return {
      ok: false,
      requestId: request.requestId,
      provider,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function writeMemoryResponse(
  groupFolder: string,
  requestId: string,
  response: MemoryIpcResponse,
): void {
  assertValidRequestId(requestId);
  const ipcDir = resolveGroupIpcPath(groupFolder);
  const responsesDir = path.join(ipcDir, 'memory-responses');
  fs.mkdirSync(responsesDir, { recursive: true });

  const filePath = path.join(responsesDir, `${requestId}.json`);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(response, null, 2));
  fs.renameSync(tmpPath, filePath);
}
