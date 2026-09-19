import { App, SocketModeReceiver } from '@slack/bolt';

import {
  missingSlackBotScopes,
  SLACK_REQUIRED_BOT_SCOPES,
} from '../../cli/slack-install-scopes.js';

export type SlackValidationCheck = {
  id: 'bot_auth' | 'scopes' | 'socket_mode' | 'app_pairing';
  label: string;
  status: 'pass' | 'fail';
  detail?: string;
};

export async function validateSlackWorkspaceCandidate(input: {
  botToken: string;
  appToken: string;
  timeoutMs?: number;
}): Promise<{
  checks: SlackValidationCheck[];
  identity: {
    appId: string;
    botId: string;
    botUserId: string;
    teamId: string;
    teamName?: string;
  };
}> {
  const checks: SlackValidationCheck[] = [];
  const authResponse = await fetch('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: { authorization: `Bearer ${input.botToken}` },
    signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
  });
  const auth = (await authResponse.json().catch(() => null)) as null | {
    ok?: boolean;
    error?: string;
    bot_id?: string;
    user_id?: string;
    team_id?: string;
    team?: string;
  };
  if (
    !authResponse.ok ||
    !auth?.ok ||
    !auth.bot_id ||
    !auth.user_id ||
    !auth.team_id
  ) {
    throw validationError(
      checks,
      'bot_auth',
      'Bot authentication',
      auth?.error ?? 'Slack rejected the bot token.',
    );
  }
  checks.push({ id: 'bot_auth', label: 'Bot authentication', status: 'pass' });

  const granted = (authResponse.headers.get('x-oauth-scopes') ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  const missing = missingSlackBotScopes(granted).core;
  if (granted.length === 0 || missing.length > 0) {
    const required =
      missing.length > 0 ? missing : [...SLACK_REQUIRED_BOT_SCOPES];
    throw validationError(
      checks,
      'scopes',
      'Required bot scopes',
      `Missing scopes: ${required.join(', ')}`,
      required,
    );
  }
  checks.push({ id: 'scopes', label: 'Required bot scopes', status: 'pass' });

  const receiver = new SocketModeReceiver({ appToken: input.appToken });
  const app = new App({ token: input.botToken, receiver });
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      app.start(),
      new Promise<never>(
        (_, reject) =>
          (timeout = setTimeout(
            () => reject(new Error('Slack Socket Mode hello timed out.')),
            input.timeoutMs ?? 15_000,
          )),
      ),
    ]);
    checks.push({
      id: 'socket_mode',
      label: 'Socket Mode hello',
      status: 'pass',
    });
  } catch (error) {
    throw validationError(
      checks,
      'socket_mode',
      'Socket Mode hello',
      error instanceof Error ? error.message : 'Socket Mode failed.',
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    await app.stop().catch(() => undefined);
  }

  const botResponse = (await app.client.bots.info({ bot: auth.bot_id })) as {
    ok?: boolean;
    bot?: { app_id?: string };
    error?: string;
  };
  const tokenAppId = appIdFromAppToken(input.appToken);
  const botAppId = botResponse.bot?.app_id;
  if (!tokenAppId || !botResponse.ok || !botAppId || tokenAppId !== botAppId) {
    throw validationError(
      checks,
      'app_pairing',
      'Bot and app token pairing',
      botResponse.error ??
        'The bot token and app token belong to different Slack apps.',
    );
  }
  checks.push({
    id: 'app_pairing',
    label: 'Bot and app token pairing',
    status: 'pass',
  });
  return {
    checks,
    identity: {
      appId: botAppId,
      botId: auth.bot_id,
      botUserId: auth.user_id,
      teamId: auth.team_id,
      ...(auth.team ? { teamName: auth.team } : {}),
    },
  };
}

function appIdFromAppToken(token: string): string | null {
  const match = token.match(/^xapp-\d+-([A-Z0-9]+)-/);
  return match?.[1] ?? null;
}

function validationError(
  checks: SlackValidationCheck[],
  id: SlackValidationCheck['id'],
  label: string,
  detail: string,
  missingScopes: string[] = [],
) {
  checks.push({ id, label, status: 'fail', detail });
  return Object.assign(new Error(detail), { checks, missingScopes });
}
