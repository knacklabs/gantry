import { afterEach, expect, it, vi } from 'vitest';

const start = vi.hoisted(() => vi.fn());
const stop = vi.hoisted(() => vi.fn());
const botsInfo = vi.hoisted(() => vi.fn());

vi.mock('@slack/bolt', () => ({
  SocketModeReceiver: class {},
  App: class {
    client = { bots: { info: botsInfo } };
    start = start;
    stop = stop;
  },
}));

import { validateSlackWorkspaceCandidate } from '@core/application/onboarding/slack-workspace-validation.js';
import { SLACK_REQUIRED_BOT_SCOPES } from '@core/cli/slack-install-scopes.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it('reports the scope Slack says bots.info still needs', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            bot_id: 'B123',
            user_id: 'U123',
            team_id: 'T123',
            team: 'KnackLabs',
          }),
          {
            headers: {
              'content-type': 'application/json',
              'x-oauth-scopes': SLACK_REQUIRED_BOT_SCOPES.join(','),
            },
          },
        ),
      ),
    ),
  );
  start.mockResolvedValue(undefined);
  stop.mockResolvedValue(undefined);
  botsInfo.mockRejectedValue(
    Object.assign(new Error('An API error occurred: missing_scope'), {
      code: 'slack_webapi_platform_error',
      data: {
        ok: false,
        error: 'missing_scope',
        needed: 'users:read',
        provided: 'chat:write',
      },
    }),
  );

  await expect(
    validateSlackWorkspaceCandidate({
      botToken: 'xoxb-test',
      appToken: 'xapp-1-A123-test',
    }),
  ).rejects.toMatchObject({
    message: 'Missing scopes: users:read',
    missingScopes: ['users:read'],
    checks: [
      { id: 'bot_auth', status: 'pass' },
      {
        id: 'scopes',
        status: 'fail',
        detail: 'Missing scopes: users:read',
      },
      { id: 'socket_mode', status: 'pass' },
    ],
  });
});
