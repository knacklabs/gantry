import { applyMigrations } from './db/migrate.js';
import { loadRuntimeEnv } from './dotenv-load.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';
import { startHttpServer } from './server.js';
import { startDigestWatcher } from './watcher/index.js';
import { createAnthropicExtractorLlm } from './extractor/llm-client.js';
import { bootstrapGantryCredentials } from './gantry-credentials.js';
import { resolveBackgroundToken } from './background-token.js';
import { createPool } from './db/pool.js';
import { bootstrapFirstAdminUser } from './admin-bootstrap.js';

// Public surface (also used by tests / the migrate + smoke scripts).
export { loadEnv } from './env.js';
export type { BoondiCrmEnv } from './env.js';
export { startHttpServer } from './server.js';
export { createPool } from './db/pool.js';
export { RecordsRepository } from './db/records-repository.js';
export type { BusinessRecord, RecordInput } from './db/types.js';
export { scoreLead, bandForScore } from './scoring.js';
export { registerAllTools, REGISTERED_TOOL_NAMES } from './tools/index.js';
export { createLogger } from './logger.js';
export {
  IDENTITY_HEADER_NAME,
  computeIdentitySignature,
  verifyIdentityHeader,
} from './identity/identity-header.js';

const isEntry =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('/mcp-crm/dist/index.js') ||
    process.argv[1].endsWith('packages/mcp-crm/src/index.ts'));

if (isEntry) {
  void (async () => {
    loadRuntimeEnv();
    const env = loadEnv();
    const bootLog = (msg: string, extra?: Record<string, unknown>) =>
      console.error(
        JSON.stringify({ level: 'info', service: 'mcp-crm', msg, ...(extra ?? {}) }),
      );

    // Resolve the Anthropic credential from core's Credential Center (the gantry
    // schema's model_credentials table) and project CLAUDE_CODE_OAUTH_TOKEN — the
    // same projection core's model gateway makes. loadRuntimeEnv() above has
    // already loaded ~/gantry/.env into process.env (including
    // SECRET_ENCRYPTION_KEY / SECRET_ENCRYPTION_KEYRING_JSON, which are NOT
    // forbidden runtime-secret names), so the package default
    // EnvRuntimeSecretProvider (process.env-backed) can read the key. A short-lived
    // pool scoped to the gantry schema reads the row, then is closed.
    // Token seam: a dedicated background token (.env) isolates the background
    // rate budget and WINS; unset → shared Gantry credential (same token in dev).
    const background = resolveBackgroundToken();
    if (background.source === 'background_env' && background.token) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = background.token;
      bootLog('background_token_source', {
        source: 'GANTRY_BACKGROUND_ANTHROPIC_TOKEN',
      });
    } else {
      // A short-lived pool scoped to the gantry schema reads the model_credentials
      // row, then is closed.
      const credPool = createPool(env.databaseUrl, env.gantrySchema, 2);
      try {
        await bootstrapGantryCredentials(credPool, {
          appId: env.modelAppId,
          log: bootLog,
        });
        bootLog('background_token_source', { source: 'gantry_credential_center' });
      } finally {
        await credPool.end().catch(() => undefined);
      }
    }
    const logger = createLogger({
      level: env.logLevel,
      format: env.logFormat,
      context: { service: 'mcp-crm' },
    });

    // Always apply our own (idempotent) migrations on boot, then start. The
    // operator just runs the server with .env; no manual migrate step.
    applyMigrations({
      databaseUrl: env.databaseUrl,
      schema: env.dbSchema,
      // One-time: move any pre-existing rows out of Gantry's schema into ours on the
      // first boot after the schema flip (no-op once dbSchema === gantrySchema again).
      gantrySchema: env.gantrySchema,
      logger,
    })
      .then(async () => {
        const pool = createPool(
          env.databaseUrl,
          env.dbSchema,
          env.crmLeadQueryExtractionWatcher.dbPoolSize,
          logger,
        );
        await bootstrapFirstAdminUser({ env, pool, logger });
        return startHttpServer({ env, logger, pool });
      })
      .then(
        (running) => {
          // Digest watcher: LLM extraction from session-end digests.
          // Started here so it shares the same pool/lifecycle.
          const stopWatcher = startDigestWatcher({
            env,
            logger,
            pool: running.pool,
            repo: running.repo,
            llm: createAnthropicExtractorLlm(env),
          });

          let shuttingDown = false;
          const shutdown = async () => {
            if (shuttingDown) return;
            shuttingDown = true;
            stopWatcher();
            await running.close().catch(() => undefined);
            await running.pool.end().catch(() => undefined);
            process.exit(0);
          };
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);
        },
        (err) => {
          logger.fatal(
            { err: err instanceof Error ? err.message : String(err) },
            'boondi_crm_failed_to_start',
          );
          process.exit(1);
        },
      );
  })();
}
