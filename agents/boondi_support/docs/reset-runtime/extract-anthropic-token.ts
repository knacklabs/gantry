/**
 * extract-anthropic-token.ts
 *
 * Reads the *decrypted* Anthropic "Claude Code OAuth" token from the live Gantry
 * database (Model Credential Center) and prints it to stdout wrapped in unique
 * markers so the caller can recover it from any surrounding log noise.
 *
 * This is the scripted equivalent of "step 1: get the token from the db, store
 * temporary". It is run by reset-gantry-runtime.sh BEFORE the Postgres volume is
 * wiped, so the exact token can be re-applied to the fresh database afterwards.
 *
 * Modes:
 *   (default)  prints  __GANTRY_OAUTH_BEGIN__<token>__GANTRY_OAUTH_END__  on stdout.
 *   --check    prints ONLY a non-secret summary (provider, authMode, format,
 *              length, sha256 fingerprint) to stderr and exits. Never prints the token.
 *
 * Env:
 *   GANTRY_HOME  runtime home (default ~/gantry). The config layer loads
 *                <GANTRY_HOME>/.env for GANTRY_DATABASE_URL + SECRET_ENCRYPTION_KEY.
 *
 * Run from the repo root, e.g.:
 *   GANTRY_HOME=~/gantry npx tsx agents/boondi_support/docs/reset-runtime/extract-anthropic-token.ts --check
 *
 * Exit codes: 0 ok | 1 unexpected error | 3 no active credential | 4 bad token format
 */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const RUNTIME_HOME =
  process.env.GANTRY_HOME?.trim() || path.join(os.homedir(), 'gantry');
// Ensure modules that read GANTRY_HOME at load time see the resolved value.
process.env.GANTRY_HOME = RUNTIME_HOME;

const CHECK_ONLY = process.argv.includes('--check');
const APP_ID = 'default';
const PROVIDER_ID = 'anthropic';
const OAUTH_FIELD = 'oauthToken';
const OAUTH_PREFIX = 'sk-ant-oat01';

async function main(): Promise<void> {
  // Dynamic imports AFTER GANTRY_HOME is set, so the config/storage layer reads
  // the right <runtime>/.env at module-evaluation time.
  const { createStorageRuntime } = await import(
    '../../../../apps/core/src/adapters/storage/postgres/factory.js'
  );
  const { ModelCredentialService } = await import(
    '../../../../apps/core/src/application/model-credentials/model-credential-service.js'
  );

  const storage = createStorageRuntime();
  try {
    // Mirror the CLI's construction (credentials.ts withCredentialServices).
    // The audit publisher is never invoked on a read, so a no-op is safe here.
    const service = new ModelCredentialService(
      storage.repositories.modelCredentials,
      async () => {},
    );
    const credential = await service.getActiveCredential({
      appId: APP_ID as never,
      providerId: PROVIDER_ID as never,
    });

    const rawToken = credential?.payload?.[OAUTH_FIELD];
    const token = typeof rawToken === 'string' ? rawToken.trim() : '';

    if (!token) {
      console.error(
        `[extract] No active "${PROVIDER_ID}" credential with an "${OAUTH_FIELD}" field was found in the database.`,
      );
      process.exitCode = 3;
      return;
    }
    if (!token.startsWith(OAUTH_PREFIX)) {
      console.error(
        `[extract] Stored "${PROVIDER_ID}" token does not look like a Claude Code OAuth token (expected "${OAUTH_PREFIX}-...").`,
      );
      process.exitCode = 4;
      return;
    }

    if (CHECK_ONLY) {
      const fingerprint = crypto
        .createHash('sha256')
        .update(token)
        .digest('hex')
        .slice(0, 16);
      console.error(
        `[extract] OK provider=${PROVIDER_ID} authMode=${credential?.authMode} ` +
          `format=${OAUTH_PREFIX} length=${token.length} sha256=${fingerprint}`,
      );
      return;
    }

    process.stdout.write(`__GANTRY_OAUTH_BEGIN__${token}__GANTRY_OAUTH_END__\n`);
  } finally {
    await storage.runtimeEventNotifier.close();
    await storage.service.close();
  }
}

main().catch((error) => {
  console.error(
    '[extract] failed:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
