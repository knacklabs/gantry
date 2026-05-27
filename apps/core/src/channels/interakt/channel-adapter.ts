import { logger } from '../../infrastructure/logging/logger.js';
import type { ChannelOpts } from '../channel-provider.js';

import { InteraktChannel } from './channel.js';

function runtimeSecret(opts: ChannelOpts, env: string): string {
  return opts.runtimeSecrets?.getOptionalSecret({ env })?.trim() ?? '';
}

// Factory used by register-builtins.ts's lazy importer.
// Mirrors the slack/telegram null-on-missing pattern: if any required
// runtime secret is absent, log a warning and return null so the channel
// is silently skipped during connectEnabledChannels.
export function createInteraktChannel(
  opts: ChannelOpts,
): InteraktChannel | null {
  const apiKey = runtimeSecret(opts, 'INTERAKT_BOT_TOKEN');
  const webhookSecret = runtimeSecret(opts, 'INTERAKT_WEBHOOK_SECRET');
  const businessPhoneNumber = runtimeSecret(
    opts,
    'INTERAKT_BUSINESS_PHONE_NUMBER',
  );
  const baseUrl =
    runtimeSecret(opts, 'INTERAKT_BASE_URL') || 'https://api.interakt.ai/v1';

  if (!apiKey || !webhookSecret || !businessPhoneNumber) {
    logger.warn(
      {
        channel: 'interakt',
        missing: {
          INTERAKT_BOT_TOKEN: !apiKey,
          INTERAKT_WEBHOOK_SECRET: !webhookSecret,
          INTERAKT_BUSINESS_PHONE_NUMBER: !businessPhoneNumber,
        },
      },
      'Interakt: required env vars missing — skipping channel connect. ' +
        'Set INTERAKT_BOT_TOKEN, INTERAKT_WEBHOOK_SECRET, and ' +
        'INTERAKT_BUSINESS_PHONE_NUMBER in <GANTRY_HOME>/.env.',
    );
    return null;
  }

  // Operator-visible startup log so misconfigurations (e.g. accidental
  // double-base64 of the API key) surface quickly. We expose only the first
  // eight characters, never the full secret.
  logger.info(
    {
      channel: 'interakt',
      apiKeyPrefix: `${apiKey.slice(0, 8)}…`,
      baseUrl,
      businessPhoneNumber,
    },
    'Interakt channel initialised',
  );

  return new InteraktChannel({
    apiKey,
    webhookSecret,
    businessPhoneNumber,
    baseUrl,
    onMessage: opts.onMessage,
    onChatMetadata: opts.onChatMetadata,
  });
}
