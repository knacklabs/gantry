import type { Pool } from 'pg';
import {
  decryptCredentialSecretValue,
  modelCredentialAadContext,
  EnvRuntimeSecretProvider,
  SECRET_ENCRYPTION_KEY_ENV,
  isCredentialSecretCryptoError,
  type RuntimeSecretProvider,
} from '@gantry/credential-crypto';

export interface BootstrapGantryCredentialsOptions {
  // The Gantry APP id that owns the model_credentials row (model_credentials.app_id).
  appId: string;
  // Provides SECRET_ENCRYPTION_KEY / SECRET_ENCRYPTION_KEYRING_JSON for decryption.
  // The connector builds this from ~/gantry/.env; defaults to process.env.
  secrets?: RuntimeSecretProvider;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

interface ModelCredentialRow {
  payload_encrypted: string;
  auth_mode: string;
  schema_version: number;
}

const PROVIDER_ID = 'anthropic';

// Resolve the connector's Anthropic credential from core's Credential Center
// (the model_credentials table) and project it into THIS process's env as
// CLAUDE_CODE_OAUTH_TOKEN — exactly the projection core's model gateway makes
// for claude_code_oauth. The extractor hands this token to the Claude Agent
// SDK's query() (which spawns the Claude CLI). No proxy/CA: the OAuth token
// reaches Anthropic directly, like core's agent.
//
// No-ops (with a clear log, never throwing) when: a raw ANTHROPIC_API_KEY is
// already set (it wins), there is no active row, SECRET_ENCRYPTION_KEY is not
// available, or the ciphertext fails to decrypt — the extractor then
// self-disables exactly as it did on OneCLI-broker-unreachable.
export async function bootstrapGantryCredentials(
  pool: Pool,
  options: BootstrapGantryCredentialsOptions,
): Promise<void> {
  const log = options.log ?? (() => undefined);
  const secrets: RuntimeSecretProvider =
    options.secrets ?? new EnvRuntimeSecretProvider();

  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    log('gantry_creds_skip_raw_key');
    return; // explicit raw key wins, same as OneCLI did
  }

  if (!secrets.getOptionalSecret({ env: SECRET_ENCRYPTION_KEY_ENV })?.trim()) {
    log('gantry_creds_no_key', { env: SECRET_ENCRYPTION_KEY_ENV });
    return;
  }

  let row: ModelCredentialRow | undefined;
  try {
    const result = await pool.query<ModelCredentialRow>(
      `SELECT payload_encrypted, auth_mode, schema_version
         FROM model_credentials
        WHERE app_id = $1 AND provider_id = $2 AND status = 'active'
        LIMIT 1`,
      [options.appId, PROVIDER_ID],
    );
    row = result.rows[0];
  } catch (err) {
    log('gantry_creds_query_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!row) {
    log('gantry_creds_no_row', { appId: options.appId, provider: PROVIDER_ID });
    return;
  }

  let token: string | undefined;
  try {
    const plaintext = decryptCredentialSecretValue(
      row.payload_encrypted,
      modelCredentialAadContext({
        appId: options.appId,
        providerId: PROVIDER_ID,
        authMode: row.auth_mode,
        schemaVersion: row.schema_version,
      }),
      secrets,
    );
    const payload = JSON.parse(plaintext) as { oauthToken?: unknown };
    if (typeof payload.oauthToken === 'string' && payload.oauthToken.trim()) {
      token = payload.oauthToken.trim();
    }
  } catch (err) {
    log('gantry_creds_decrypt_failed', {
      isCryptoError: isCredentialSecretCryptoError(err),
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!token) {
    log('gantry_creds_no_token', { appId: options.appId });
    return;
  }

  process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  log('gantry_creds_loaded', { appId: options.appId, provider: PROVIDER_ID });
}
