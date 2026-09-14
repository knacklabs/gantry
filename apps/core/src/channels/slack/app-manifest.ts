// Feature scopes are advisory: the runtime degrades honestly without them.
export const SLACK_FEATURE_BOT_SCOPES = [
  'files:read',
  'files:write',
  'canvases:read',
  'canvases:write',
] as const;

export const SLACK_REQUIRED_BOT_SCOPES = [
  'chat:write',
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

const SLACK_FRESH_INSTALL_BOT_SCOPES = ['commands'] as const;

export const SLACK_APP_MANIFEST = {
  oauth_config: {
    scopes: {
      bot: [
        ...SLACK_REQUIRED_BOT_SCOPES,
        ...SLACK_FRESH_INSTALL_BOT_SCOPES,
        ...SLACK_FEATURE_BOT_SCOPES,
      ],
    },
  },
} as const;

const SLACK_BOT_EVENTS = [
  'app_mention',
  'member_joined_channel',
  'message.channels',
  'message.groups',
  'message.im',
  'message.mpim',
] as const;

export function normalizeSlackAppName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, 35) || 'Gantry';
}

export function slackBotDisplayName(name: string): string {
  return (
    name
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'gantry'
  );
}

export function slackAppManifestFor(employeeName: string) {
  const name = normalizeSlackAppName(employeeName);
  return {
    display_information: {
      name,
      description: 'Gantry AI employee',
      background_color: '#1b1a18',
    },
    features: {
      bot_user: {
        display_name: slackBotDisplayName(employeeName),
        always_online: true,
      },
      slash_commands: [
        {
          command: '/gantry',
          description: 'Open Gantry commands',
          should_escape: false,
        },
      ],
    },
    oauth_config: SLACK_APP_MANIFEST.oauth_config,
    settings: {
      event_subscriptions: { bot_events: [...SLACK_BOT_EVENTS] },
      interactivity: { is_enabled: true },
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

export function slackManifestPermissionGroups() {
  return [
    {
      title: 'Core messaging',
      description:
        'Read invited conversations, receive mentions, and send replies.',
      scopes: [...SLACK_REQUIRED_BOT_SCOPES],
    },
    {
      title: 'Files and canvases',
      description:
        'Read and create files or canvases when your employee needs them.',
      scopes: [...SLACK_FEATURE_BOT_SCOPES],
    },
  ];
}

export function missingSlackBotScopes(grantedScopes: readonly string[]): {
  core: string[];
  feature: string[];
} {
  const granted = new Set(grantedScopes.map((scope) => scope.trim()));
  return {
    core: SLACK_REQUIRED_BOT_SCOPES.filter((scope) => !granted.has(scope)),
    feature: SLACK_FEATURE_BOT_SCOPES.filter((scope) => !granted.has(scope)),
  };
}

export function formatSlackBotScopes(): string {
  return [
    ...SLACK_REQUIRED_BOT_SCOPES,
    ...SLACK_FRESH_INSTALL_BOT_SCOPES,
    ...SLACK_FEATURE_BOT_SCOPES,
  ].join(', ');
}

export function slackBotScopeFailure(
  rawHeader: string | null,
):
  | { message: string; nextAction: string; missingScopes: string[] }
  | undefined {
  const grantedScopes = (rawHeader || '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (grantedScopes.length === 0) return undefined;
  const { core } = missingSlackBotScopes(grantedScopes);
  if (core.length === 0) return undefined;
  return {
    missingScopes: core,
    message: `Slack bot token is missing required scopes: ${core.join(', ')}.`,
    nextAction:
      'Add the missing bot scopes in the Slack app settings, reinstall the app to this workspace to reauthorize it, copy the new Bot User OAuth token, and retry.',
  };
}

export function slackBotScopeWarning(
  rawHeader: string | null,
): string | undefined {
  const grantedScopes = (rawHeader || '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (grantedScopes.length === 0) return undefined;
  const { feature } = missingSlackBotScopes(grantedScopes);
  if (feature.length === 0) return undefined;
  return `Slack file/canvas features need scopes this token lacks: ${feature.join(', ')}. Add them and reinstall the app to this workspace when you want those features; messaging works without them. See docs/operations/slack-app-install.md.`;
}

export const slackInstallScopes = {
  text: formatSlackBotScopes,
  validateHeader: validateSlackBotScopeHeader,
  featureWarning: slackBotScopeWarning,
  setupNote: slackSetupNoteText,
};

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
