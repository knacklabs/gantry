/**
 * store-anthropic-token.ts
 *
 * Stores an Anthropic "Claude Code OAuth" token into the Gantry Model Credential
 * Center (encrypted, in the database) NON-INTERACTIVELY.
 *
 * This is the scripted equivalent of "step 2":
 *   npm run cli:dev -- credentials model set anthropic
 *     -> choose "Claude Code OAuth"
 *     -> paste the token
 * It calls the exact same code path the menu calls under the hood
 * (storeModelCredentialInput -> ModelCredentialService.set), which also runs
 * storage migrations first, so it works against a freshly-initialised database.
 *
 * The token is read from the env var GANTRY_RESET_OAUTH_TOKEN (never argv), so it
 * does not land in the process list or shell history.
 *
 * Run from the repo root, e.g.:
 *   GANTRY_HOME=~/gantry GANTRY_RESET_OAUTH_TOKEN="sk-ant-oat01-..." \
 *     npx tsx agents/boondi_support/docs/reset-runtime/store-anthropic-token.ts
 *
 * Exit codes: 0 ok | 1 unexpected error | 2 no token provided | 4 bad token format
 */
import os from 'node:os';
import path from 'node:path';

const RUNTIME_HOME =
  process.env.GANTRY_HOME?.trim() || path.join(os.homedir(), 'gantry');
process.env.GANTRY_HOME = RUNTIME_HOME;

const OAUTH_PREFIX = 'sk-ant-oat01';
const token = process.env.GANTRY_RESET_OAUTH_TOKEN?.trim() ?? '';

async function main(): Promise<void> {
  if (!token) {
    console.error('[store] GANTRY_RESET_OAUTH_TOKEN is empty; nothing to store.');
    process.exitCode = 2;
    return;
  }
  if (!token.startsWith(OAUTH_PREFIX)) {
    console.error(
      `[store] Refusing: token does not look like a Claude Code OAuth token ("${OAUTH_PREFIX}-...").`,
    );
    process.exitCode = 4;
    return;
  }

  const { storeModelCredentialInput } = await import(
    '../../../../apps/core/src/cli/credentials.js'
  );
  await storeModelCredentialInput({
    runtimeHome: RUNTIME_HOME,
    providerId: 'anthropic',
    authMode: 'claude_code_oauth',
    payload: { oauthToken: token },
  });
  console.error('[store] Stored anthropic claude_code_oauth credential.');
}

main().catch((error) => {
  console.error('[store] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
