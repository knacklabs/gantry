import { isProtectedArtifactEntry } from '../../domain/file-artifacts/protected-virtual-path.js';
import {
  normalizeFileArtifactPath,
  normalizeFileArtifactScope,
} from '../../domain/file-artifacts/virtual-path.js';
import {
  ALL_GANTRY_MCP_TOOL_NAMES,
  AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
  DECISION_ACTOR_GANTRY_MCP_TOOL_NAMES,
  DELEGATION_DISPATCHERS,
  DURABLE_GRANT_EXCLUDED_DISPATCHERS,
  SCHEDULER_MUTATION_MCP_TOOL_NAMES,
} from '../../shared/admin-mcp-tools.js';

const GANTRY_MCP_PREFIX = 'mcp__gantry__';
const ALL_GANTRY_TOOL_NAME_SET = new Set<string>(ALL_GANTRY_MCP_TOOL_NAMES);
const EXECUTOR_TOOL_NAME_SET = new Set<string>(
  DURABLE_GRANT_EXCLUDED_DISPATCHERS,
);
const SCHEDULER_MUTATION_TOOL_NAME_SET = new Set<string>(
  SCHEDULER_MUTATION_MCP_TOOL_NAMES,
);
const HIGH_TOOL_NAME_SET = new Set<string>([
  ...SCHEDULER_MUTATION_MCP_TOOL_NAMES,
  ...AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
  ...DECISION_ACTOR_GANTRY_MCP_TOOL_NAMES,
  ...DELEGATION_DISPATCHERS,
]);

export const GantryToolRiskVerdict = {
  Low: 'low',
  High: 'high',
  Ambiguous: 'ambiguous',
} as const;

export type GantryToolRiskVerdict =
  (typeof GantryToolRiskVerdict)[keyof typeof GantryToolRiskVerdict];

export interface GantryToolRisk {
  verdict: GantryToolRiskVerdict;
  reason: string;
}

export function gantryNativeCanonicalToolName(
  toolName: string,
): { canonical: string; known: boolean } | null {
  const trimmed = toolName.trim();
  if (trimmed.startsWith(GANTRY_MCP_PREFIX)) {
    const canonical = trimmed.slice(GANTRY_MCP_PREFIX.length);
    return { canonical, known: ALL_GANTRY_TOOL_NAME_SET.has(canonical) };
  }
  return ALL_GANTRY_TOOL_NAME_SET.has(trimmed)
    ? { canonical: trimmed, known: true }
    : null;
}

export function gantryToolRisk(input: {
  toolName: string;
  toolInput: unknown;
}): GantryToolRisk {
  const trimmed = input.toolName.trim();
  const canonical = trimmed.startsWith(GANTRY_MCP_PREFIX)
    ? trimmed.slice(GANTRY_MCP_PREFIX.length)
    : trimmed;
  if (!ALL_GANTRY_TOOL_NAME_SET.has(canonical)) {
    return ambiguous('unknown gantry tool');
  }
  if (canonical === 'capability_run') {
    return high('capability dispatch requires approval');
  }
  if (EXECUTOR_TOOL_NAME_SET.has(canonical)) {
    return ambiguous('executor judged by the classifier');
  }
  if (HIGH_TOOL_NAME_SET.has(canonical)) {
    return high(
      SCHEDULER_MUTATION_TOOL_NAME_SET.has(canonical)
        ? 'scheduler mutation'
        : 'admin mutation',
    );
  }
  if (canonical === 'file') return judgeFileTool(input.toolInput);
  if (canonical === 'browser_act') return judgeBrowserAction(input.toolInput);
  return low('registered gantry tool');
}

function judgeFileTool(value: unknown): GantryToolRisk {
  if (!isRecord(value) || typeof value.action !== 'string') {
    return ambiguous('malformed file request');
  }
  try {
    if (value.action === 'list') {
      if (
        !optionalVirtualScope(value.scope) ||
        !optionalVirtualPath(value.path) ||
        !optionalPositiveInteger(value.limit, 100)
      ) {
        return ambiguous('malformed file request');
      }
      return low('virtual file read');
    }
    if (value.action === 'read') {
      if (
        !optionalVirtualScope(value.scope) ||
        !optionalVirtualPath(value.path) ||
        !optionalNonBlankString(value.artifactId) ||
        (!nonBlankString(value.artifactId) && !nonBlankString(value.path)) ||
        !optionalPositiveInteger(value.version) ||
        !optionalNonNegativeInteger(value.offset) ||
        !optionalPositiveInteger(value.readLimit, 256 * 1024)
      ) {
        return ambiguous('malformed file request');
      }
      return low('virtual file read');
    }
    if (value.action === 'write') {
      if (
        !nonBlankString(value.path) ||
        typeof value.content !== 'string' ||
        !optionalVirtualScope(value.scope) ||
        !optionalEncoding(value.encoding) ||
        !optionalString(value.contentType) ||
        !optionalBoolean(value.protected)
      ) {
        return ambiguous('malformed file request');
      }
      return protectedVirtualTarget(
        normalizeFileArtifactScope(stringOrUndefined(value.scope)),
        normalizeFileArtifactPath(value.path),
        value.protected,
      );
    }
    if (value.action === 'promote_scratch') {
      if (
        !nonBlankString(value.path) ||
        !nonBlankString(value.targetPath) ||
        !optionalVirtualScope(value.targetScope) ||
        !optionalBoolean(value.protected)
      ) {
        return ambiguous('malformed file request');
      }
      normalizeFileArtifactPath(value.path);
      return protectedVirtualTarget(
        normalizeFileArtifactScope(stringOrUndefined(value.targetScope)),
        normalizeFileArtifactPath(value.targetPath),
        value.protected,
      );
    }
  } catch {
    return ambiguous('malformed file request');
  }
  return ambiguous('malformed file request');
}

function protectedVirtualTarget(
  scope: string,
  path: string,
  protectedRequested: unknown,
): GantryToolRisk {
  return protectedRequested === true || isProtectedArtifactEntry(scope, path)
    ? high('protected virtual target')
    : low('unprotected virtual target');
}

function judgeBrowserAction(value: unknown): GantryToolRisk {
  if (
    !isRecord(value) ||
    !nonBlankString(value.action) ||
    !isRecord(value.payload)
  ) {
    return ambiguous('malformed browser request');
  }
  if (value.action !== 'file_attach' && value.action !== 'file_upload') {
    return low('browser action');
  }
  const payload = value.payload;
  const sources = ['source', 'files', 'paths'].filter((key) => key in payload);
  if (sources.length !== 1) return ambiguous('malformed browser request');
  if ('paths' in payload) {
    return isNonEmptyStringArray(payload.paths)
      ? ambiguous('raw browser file path')
      : ambiguous('malformed browser request');
  }
  if ('files' in payload) {
    return validInlineFiles(payload.files)
      ? low('inline browser files')
      : ambiguous('malformed browser request');
  }
  if (!isRecord(payload.source) || !nonBlankString(payload.source.type)) {
    return ambiguous('malformed browser request');
  }
  const source = payload.source;
  if (source.type === 'path') {
    return nonBlankString(source.path) || isNonEmptyStringArray(source.paths)
      ? ambiguous('raw browser file path')
      : ambiguous('malformed browser request');
  }
  if (source.type === 'artifact') {
    if (!nonBlankString(source.artifactId) && !nonBlankString(source.path)) {
      return ambiguous('malformed browser request');
    }
    return value.action === 'file_attach'
      ? low('artifact browser attachment')
      : ambiguous('artifact upload judged by the classifier');
  }
  if (source.type === 'bytes') {
    return validInlineFile(source)
      ? low('inline browser files')
      : ambiguous('malformed browser request');
  }
  return ambiguous('malformed browser request');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function nonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalNonBlankString(value: unknown): boolean {
  return value === undefined || nonBlankString(value);
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function optionalPositiveInteger(value: unknown, max = Infinity): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' &&
      Number.isInteger(value) &&
      value > 0 &&
      value <= max)
  );
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 0)
  );
}

function optionalEncoding(value: unknown): boolean {
  return value === undefined || value === 'utf8' || value === 'base64';
}

function optionalVirtualScope(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string') return false;
  normalizeFileArtifactScope(value);
  return true;
}

function optionalVirtualPath(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string') return false;
  normalizeFileArtifactPath(value);
  return true;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isNonEmptyStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) && value.length > 0 && value.every(nonBlankString)
  );
}

function validInlineFiles(value: unknown): boolean {
  return Array.isArray(value) && value.every(validInlineFile);
}

function validInlineFile(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.content === 'string' &&
    (value.name === undefined || nonBlankString(value.name)) &&
    optionalEncoding(value.encoding)
  );
}

function low(reason: string): GantryToolRisk {
  return { verdict: GantryToolRiskVerdict.Low, reason };
}

function high(reason: string): GantryToolRisk {
  return { verdict: GantryToolRiskVerdict.High, reason };
}

function ambiguous(reason: string): GantryToolRisk {
  return { verdict: GantryToolRiskVerdict.Ambiguous, reason };
}
