export const SLACK_REQUIRED_BOT_SCOPES = [
  'chat:write',
  'files:read',
  'files:write',
  'canvases:read',
  'canvases:write',
  'app_mentions:read',
  'channels:read',
  'channels:history',
  'groups:read',
  'groups:history',
  'im:read',
  'im:history',
  'mpim:read',
  'mpim:history',
] as const;

export const SLACK_APP_MANIFEST = {
  oauth_config: {
    scopes: {
      bot: [...SLACK_REQUIRED_BOT_SCOPES],
    },
  },
} as const;

export function missingSlackBotScopes(
  grantedScopes: readonly string[],
): string[] {
  const granted = new Set(grantedScopes.map((scope) => scope.trim()));
  return SLACK_REQUIRED_BOT_SCOPES.filter((scope) => !granted.has(scope));
}

export function formatSlackBotScopes(): string {
  return SLACK_REQUIRED_BOT_SCOPES.join(', ');
}

export function slackBotScopeFailure(rawHeader: string | null):
  | {
      message: string;
      nextAction: string;
      missingScopes: string[];
    }
  | undefined {
  const grantedScopes = (rawHeader || '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (grantedScopes.length === 0) return undefined;
  const missingScopes = missingSlackBotScopes(grantedScopes);
  if (missingScopes.length === 0) return undefined;
  return {
    missingScopes,
    message: `Slack bot token is missing required scopes: ${missingScopes.join(', ')}.`,
    nextAction:
      'Add the missing bot scopes in the Slack app settings, reinstall the app to this workspace to reauthorize it, copy the new Bot User OAuth token, and retry.',
  };
}

export function validateSlackBotScopeHeader(
  headers: Headers,
  identity: { team_id?: string; team?: string; user_id?: string },
) {
  const failure = slackBotScopeFailure(headers.get('x-oauth-scopes'));
  return failure
    ? {
        ok: false as const,
        teamId: identity.team_id,
        teamName: identity.team,
        userId: identity.user_id,
        ...failure,
      }
    : undefined;
}

export const slackInstallScopes = {
  text: formatSlackBotScopes,
  validateHeader: validateSlackBotScopeHeader,
  setupNote: slackSetupNoteText,
};

export function slackSetupNoteText(): string {
  return [
    'Create the Slack app first: create an app in the target workspace, add a bot user, then install it.',
    `Required bot scopes: ${slackInstallScopes.text()}.`,
    'Enable Socket Mode and generate an app-level xapp token with connections:write.',
    'For Slack DMs, enable App Home > Messages Tab and allow users to send messages from the tab.',
    'After adding files:read, files:write, canvases:read, canvases:write, or changing any scope or App Home setting, reinstall the app so existing workspace installations receive the new access, then invite it to the target channel or DM it once before discovery.',
    'Docs: https://docs.slack.dev/apis/events-api/using-socket-mode/',
  ].join('\n');
}
