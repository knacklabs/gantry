import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Environment for the boondi-crm MCP server. Mirrors mcp-shopify/src/env.ts in
// shape (typed config, fail-fast on missing required values). The identity
// SECRET is shared with the runtime (MCP_IDENTITY_SECRET) so the signed
// X-Caller-Identity verifies here exactly as it does for Shopify; everything
// else is boondi-crm-specific (its own port, DB url, schemas). Watcher runtime
// behavior is read from Gantry settings.yaml, not env.
//
// Credential note: the connector resolves its Anthropic credential from core's
// Credential Center (the gantry schema's model_credentials table) via
// bootstrapGantryCredentials, decrypting with SECRET_ENCRYPTION_KEY from
// ~/gantry/.env.

export type IdentityConfig =
  | { mode: 'disabled' }
  | { mode: 'optional'; secret: string; maxAgeSec: number }
  | { mode: 'required'; secret: string; maxAgeSec: number };

export interface BoondiCrmEnv {
  port: number;
  databaseUrl: string;
  // The CRM's OWN schema (owns its tables end-to-end).
  dbSchema: string;
  // Gantry's schema, read-only, for the reconciler's transcript reads.
  gantrySchema: string;
  identity: IdentityConfig;
  requireVerifiedIdentity: boolean;
  identityMaxAgeSec: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  logFormat: 'json' | 'text';
  crmLeadQueryExtractionWatcher: {
    enabled: boolean;
    pollIntervalMs: number;
    model: string;
  };
  reconcileAgentId: string;
  // The Gantry APP id that owns the model_credentials row the connector decrypts
  // its Anthropic credential from (model_credentials.app_id). Defaults to core's
  // default app. (Distinct from reconcileAgentId, which is an AGENT id.)
  modelAppId: string;
  anthropicApiKey?: string;
}

const VALID_LOG_LEVELS = new Set([
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
] as const);

type LogLevel = BoondiCrmEnv['logLevel'];

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function requiredSettingsField(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required settings.yaml field: ${name}`);
  }
  return value;
}

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]*$/i;

// Schema names are interpolated into SQL (search_path + qualified gantry reads),
// so validate them — never trust a raw env value into a query.
function parseSchema(
  name: string,
  raw: string | undefined,
  fallback: string,
): string {
  const value = raw?.trim() || fallback;
  if (!SCHEMA_PATTERN.test(value)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return value;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0 || value > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return value;
}

function parsePositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function settingsPath(source: NodeJS.ProcessEnv): string {
  const raw = source.GANTRY_HOME?.trim() || path.join(os.homedir(), 'gantry');
  return path.join(path.resolve(expandHome(raw)), 'settings.yaml');
}

function stripInlineComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === '#' && !inSingle && !inDouble) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw.trimEnd();
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readScalarMapUnder(
  yaml: string,
  pathParts: string[],
): Record<string, string> | null {
  const lines = yaml.split(/\r?\n/);
  let index = 0;
  let expectedIndent = 0;
  for (const part of pathParts) {
    const matchIndex = lines.findIndex((line, lineIndex) => {
      if (lineIndex < index) return false;
      const stripped = stripInlineComment(line);
      if (!stripped.trim()) return false;
      const indent = stripped.match(/^ */)?.[0].length ?? 0;
      if (indent !== expectedIndent) return false;
      const trimmed = stripped.trim();
      return trimmed === `${part}:` || unquote(trimmed.slice(0, -1)) === part;
    });
    if (matchIndex < 0) return null;
    index = matchIndex + 1;
    expectedIndent += 2;
  }
  const out: Record<string, string> = {};
  for (let i = index; i < lines.length; i += 1) {
    const stripped = stripInlineComment(lines[i] ?? '');
    if (!stripped.trim()) continue;
    const indent = stripped.match(/^ */)?.[0].length ?? 0;
    if (indent < expectedIndent) break;
    if (indent !== expectedIndent) continue;
    const trimmed = stripped.trim();
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = unquote(trimmed.slice(0, colon));
    const value = trimmed.slice(colon + 1).trim();
    if (value) out[key] = unquote(value);
  }
  return out;
}

function parseWatcherBool(value: string | undefined, pathPrefix: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${pathPrefix}.enabled must be true/false`);
}

function parseWatcherPositiveMs(
  value: string | undefined,
  pathPrefix: string,
): number {
  if (!value || !/^[0-9]+$/.test(value)) {
    throw new Error(`${pathPrefix} must be an integer between 1 and 86400000`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1 || parsed > 86_400_000) {
    throw new Error(`${pathPrefix} must be an integer between 1 and 86400000`);
  }
  return parsed;
}

function rejectUnsupportedSettingsKeys(
  map: Record<string, string>,
  pathPrefix: string,
  supported: readonly string[],
): void {
  const supportedSet = new Set(supported);
  const supportedText =
    supported.length > 1
      ? `${supported.slice(0, -1).join(', ')}, or ${supported.at(-1)}`
      : (supported[0] ?? '');
  for (const key of Object.keys(map)) {
    if (!supportedSet.has(key)) {
      throw new Error(
        `${pathPrefix}.${key} is not supported. Configure ${supportedText}.`,
      );
    }
  }
}

function readCrmLeadQueryExtractionWatcher(source: NodeJS.ProcessEnv):
  | BoondiCrmEnv['crmLeadQueryExtractionWatcher'] {
  const pathPrefix =
    'mcp_servers.mcp:boondi-crm.crm_lead_query_extraction_watcher';
  const filePath = settingsPath(source);
  if (!fs.existsSync(filePath)) {
    throw new Error(`${pathPrefix} is required`);
  }
  const map = readScalarMapUnder(fs.readFileSync(filePath, 'utf8'), [
    'mcp_servers',
    'mcp:boondi-crm',
    'crm_lead_query_extraction_watcher',
  ]);
  if (!map) throw new Error(`${pathPrefix} is required`);
  const enabled = parseWatcherBool(map.enabled, pathPrefix);
  const pollIntervalMs = parseWatcherPositiveMs(
    map.poll_interval_ms,
    `${pathPrefix}.poll_interval_ms`,
  );
  const model = requiredSettingsField(`${pathPrefix}.model`, map.model);
  rejectUnsupportedSettingsKeys(map, pathPrefix, [
    'enabled',
    'poll_interval_ms',
    'model',
  ]);
  return {
    enabled,
    pollIntervalMs,
    model,
  };
}

function parseLogLevel(raw: string | undefined): LogLevel {
  if (!raw) return 'info';
  const lower = raw.toLowerCase();
  if (!VALID_LOG_LEVELS.has(lower as LogLevel)) {
    throw new Error(
      `Invalid LOG_LEVEL: ${raw} (allowed: ${[...VALID_LOG_LEVELS].join(', ')})`,
    );
  }
  return lower as LogLevel;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

function parseIdentity(source: NodeJS.ProcessEnv): IdentityConfig {
  // The signing secret is the runtime's identity key (shared across all MCPs).
  const secret = source.MCP_IDENTITY_SECRET?.trim() ?? '';
  const require = parseBool(
    source.BOONDI_CRM_REQUIRE_VERIFIED_IDENTITY,
    true,
  );
  const maxAgeSec = parsePositiveInt(
    'MCP_IDENTITY_MAX_AGE_SEC',
    source.MCP_IDENTITY_MAX_AGE_SEC,
    120,
  );

  if (require) {
    if (!secret) {
      throw new Error(
        'BOONDI_CRM_REQUIRE_VERIFIED_IDENTITY=true requires MCP_IDENTITY_SECRET to be set',
      );
    }
    return { mode: 'required', secret, maxAgeSec };
  }
  if (secret) return { mode: 'optional', secret, maxAgeSec };
  return { mode: 'disabled' };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): BoondiCrmEnv {
  const identity = parseIdentity(source);
  return {
    port: parsePort(source.BOONDI_CRM_MCP_PORT, 8082),
    // The CRM is a different identity end-to-end: it requires its OWN connection,
    // no silent fallback to Gantry's. Missing it is a hard, clear startup error.
    databaseUrl: required(
      'BOONDI_CRM_DATABASE_URL',
      source.BOONDI_CRM_DATABASE_URL,
    ),
    dbSchema: parseSchema(
      'BOONDI_CRM_DB_SCHEMA',
      source.BOONDI_CRM_DB_SCHEMA,
      'boondi_crm',
    ),
    gantrySchema: parseSchema(
      'BOONDI_CRM_GANTRY_SCHEMA',
      source.BOONDI_CRM_GANTRY_SCHEMA,
      'gantry',
    ),
    identity,
    requireVerifiedIdentity: identity.mode === 'required',
    identityMaxAgeSec: identity.mode === 'disabled' ? 120 : identity.maxAgeSec,
    logLevel: parseLogLevel(source.LOG_LEVEL),
    logFormat: source.LOG_FORMAT === 'text' ? 'text' : 'json',
    crmLeadQueryExtractionWatcher:
      readCrmLeadQueryExtractionWatcher(source),
    reconcileAgentId:
      source.BOONDI_CRM_AGENT_ID?.trim() || 'agent:boondi_support',
    modelAppId: source.BOONDI_CRM_MODEL_APP_ID?.trim() || 'default',
    anthropicApiKey: source.ANTHROPIC_API_KEY?.trim() || undefined,
  };
}
