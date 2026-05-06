import * as p from '@clack/prompts';
import { OneCLI } from '@onecli-sh/sdk';

import type { HostCredentialMode } from '../config/credentials/mode.js';
import { filterTrustedOnecliEnv } from '../adapters/credentials/onecli/env-policy.js';
import { validateOnecliUrl } from '../adapters/credentials/onecli/policy.js';
import {
  MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
  MODEL_RUNTIME_CREDENTIAL_NAME,
} from '../domain/models/credentials.js';

export interface CredentialSetupDraft {
  credentialMode: HostCredentialMode;
  onecliUrl: string;
  postgresSetupKind?: 'local' | 'hosted' | 'existing';
}

export type CredentialStepAction =
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'resume' }
  | { type: 'cancel' };

export const DEFAULT_LOCAL_ONECLI_URL = 'http://localhost:10254';

async function validateOneCLIReachability(
  onecliUrl: string,
): Promise<{ ok: boolean; message: string }> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const urlValidation = validateOnecliUrl(onecliUrl);
    if (!urlValidation.ok || !urlValidation.normalizedUrl) {
      return {
        ok: false,
        message: urlValidation.error || 'Invalid OneCLI URL.',
      };
    }
    const client = new OneCLI({ url: urlValidation.normalizedUrl });
    await client.ensureAgent({
      name: MODEL_RUNTIME_CREDENTIAL_NAME,
      identifier: MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
    });
    const config = await Promise.race([
      client.getContainerConfig(MODEL_RUNTIME_CREDENTIAL_IDENTIFIER),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('connection timed out after 8 seconds'));
        }, 8_000);
      }),
    ]);
    filterTrustedOnecliEnv(config.env || {});
    return {
      ok: true,
      message: `Connected to OneCLI at ${urlValidation.normalizedUrl}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `OneCLI check failed for ${onecliUrl}: ${message}`,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function verifyModelAccess(
  onecliUrl: string,
): Promise<{ ok: boolean; message: string; nextAction?: string }> {
  const check = await validateOneCLIReachability(onecliUrl);
  if (!check.ok) {
    return {
      ok: false,
      message: check.message,
      nextAction:
        'Open Model Access, add the required Claude/OpenRouter credentials once, then rerun `myclaw setup`.',
    };
  }
  return {
    ok: true,
    message: 'Model Access check passed with broker-safe configuration.',
  };
}

export async function runCredentialsStep(
  draft: CredentialSetupDraft,
): Promise<CredentialStepAction> {
  p.note(
    [
      'Model Access gives agents brokered access to Claude and other model providers.',
      'Claude/OpenRouter credentials are configured once and apply to every agent, subagent, memory run, and scheduled job.',
      'The agent runner receives broker-safe model endpoint settings only. Proxy, certificate, and raw Claude credential values are ignored.',
      'Channel, Postgres, and runtime-owned secrets still stay in runtime .env.',
    ].join('\n'),
    'Model Access',
  );

  while (true) {
    draft.credentialMode = 'onecli';
    draft.onecliUrl = draft.onecliUrl || DEFAULT_LOCAL_ONECLI_URL;
    p.note(
      [
        `Model Access URL: ${draft.onecliUrl}`,
        'For normal local setup this is the local OneCLI dashboard. Setup does not ask for this URL.',
        'Start OneCLI with the provided docker-compose.yml or your own service before continuing.',
      ].join('\n'),
      'Model Access URL',
    );

    const spinner = p.spinner();
    spinner.start('Validating Model Access...');
    const check = await validateOneCLIReachability(draft.onecliUrl);
    spinner.stop(
      check.ok
        ? 'Model Access validation passed'
        : 'Model Access validation failed',
    );

    if (check.ok) {
      p.note(
        `${check.message}\nLocal Claude credentials will be removed from runtime .env.`,
        'Model Access',
      );
      return { type: 'next' };
    }

    p.note(
      `${check.message}\nNext action: confirm Model Access URL and gateway availability.`,
      'Model Access Validation',
    );

    const followUp = await p.select({
      message: 'Model Access must be reachable before agents can run.',
      options: [
        {
          value: 'retry',
          label: 'Retry OneCLI check (Recommended)',
        },
        {
          value: 'back',
          label: 'Back',
        },
        {
          value: 'resume',
          label: 'Resume Later',
        },
        {
          value: 'cancel',
          label: 'Cancel Setup',
        },
      ],
    });
    if (p.isCancel(followUp)) return { type: 'resume' };
    if (followUp === 'retry') {
      continue;
    }
    if (followUp === 'back') return { type: 'back' };
    if (followUp === 'resume') return { type: 'resume' };
    return { type: 'cancel' };
  }
}
