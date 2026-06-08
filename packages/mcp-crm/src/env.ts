// Environment for the boondi-crm MCP server. Mirrors mcp-shopify/src/env.ts in
// shape (typed config, fail-fast on missing required values). The identity
// SECRET is shared with the runtime (MCP_IDENTITY_SECRET) so the signed
// X-Caller-Identity verifies here exactly as it does for Shopify; everything
// else is boondi-crm-specific (its own port, DB url, reconciler cadence).

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
  // Digest watcher: how often to poll gantry.agent_session_digests for new
  // session-end digests, and which agent's sessions to scope to. (The env keys
  // keep their historical BOONDI_CRM_RECONCILE_INTERVAL_MS / BOONDI_CRM_AGENT_ID
  // names for backward compatibility.)
  reconcileIntervalMs: number;
  reconcileAgentId: string;
  // The Gantry APP id that owns the model_credentials row the connector decrypts
  // its Anthropic credential from (model_credentials.app_id). Defaults to core's
  // default app. (Distinct from reconcileAgentId, which is an AGENT id.)
  modelAppId: string;
  // Extraction model for the background opportunity extractor.
  extractorModel: string;
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
    reconcileIntervalMs: parsePositiveInt(
      'BOONDI_CRM_RECONCILE_INTERVAL_MS',
      source.BOONDI_CRM_RECONCILE_INTERVAL_MS,
      240_000,
    ),
    reconcileAgentId:
      source.BOONDI_CRM_AGENT_ID?.trim() || 'agent:boondi_support',
    modelAppId: source.BOONDI_CRM_MODEL_APP_ID?.trim() || 'default',
    extractorModel:
      source.BOONDI_CRM_EXTRACTOR_MODEL?.trim() || 'claude-sonnet-4-6',
    anthropicApiKey: source.ANTHROPIC_API_KEY?.trim() || undefined,
  };
}
