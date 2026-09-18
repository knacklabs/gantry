import iconDiscord from '@iconify-icons/logos/discord-icon';
import iconMicrosoftTeams from '@iconify-icons/logos/microsoft-teams';
import iconSlack from '@iconify-icons/logos/slack-icon';
import iconTelegram from '@iconify-icons/logos/telegram';

import type { ChannelProvider } from '../channel-accounts/channel-account-queries';

const CHANNEL_ORDER = ['slack', 'teams', 'discord', 'telegram'] as const;

export type WorkspacePhase = {
  title: string;
  summary: string;
  meta: string;
  body?: string;
  guideLabel?: string;
  guideUrl?: string;
};

export const CHANNEL_CONTENT: Record<
  string,
  { icon: typeof iconSlack; intro: string; phases: WorkspacePhase[] }
> = {
  slack: {
    icon: iconSlack,
    intro:
      'Create a Slack app with everything preconfigured, then paste its two tokens here. Your employee will be ready for the channels you invite it to.',
    phases: [
      {
        title: 'Create the app',
        summary: 'One click — Slack opens ready to go',
        meta: '20 sec',
        body: 'Choose your workspace and press Create. In Slack, install it to the workspace, approve it, then generate an app-level token and copy the bot token.',
      },
      {
        title: 'Connect it',
        summary: 'Paste two tokens and you are done',
        meta: '30 sec',
      },
    ],
  },
  teams: {
    icon: iconMicrosoftTeams,
    intro:
      'Set it up once in your tenant and your employee starts answering in Teams. You will need an administrator to approve it.',
    phases: [
      {
        title: 'Register the app',
        summary: 'Create it in your tenant',
        meta: '2 min',
        body: 'Create an app registration in Entra ID, add a client secret, then copy the tenant ID, client ID, and secret.',
        guideLabel: 'Open Azure portal',
        guideUrl:
          'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
      },
      {
        title: 'Get it approved',
        summary: 'An admin grants the permissions',
        meta: 'varies',
        body: 'Graph permissions need admin consent. Send the request and come back when it is granted.',
        guideLabel: 'Open Teams developer guide',
        guideUrl: 'https://learn.microsoft.com/microsoftteams/platform/',
      },
      {
        title: 'Connect it',
        summary: 'Paste the credentials',
        meta: '30 sec',
        body: 'Tenant ID, client ID and secret go here. Gantry stores them in the broker and never shows them again.',
      },
    ],
  },
  discord: {
    icon: iconDiscord,
    intro:
      'Add the employee to your server and it starts answering in the channels you give it. Takes about a minute.',
    phases: [
      {
        title: 'Create the application',
        summary: 'Add a bot user to it',
        meta: '1 min',
        body: 'Create the application, add a bot user and turn on the message content intent so it can read replies.',
        guideLabel: 'Open Discord developers',
        guideUrl: 'https://discord.com/developers/applications',
      },
      {
        title: 'Add it to your server',
        summary: 'Invite the bot',
        meta: '20 sec',
        body: 'Generate the invite URL with the bot and commands scopes, then add it to the server.',
        guideLabel: 'Open Discord installation guide',
        guideUrl:
          'https://discord.com/developers/docs/quick-start/getting-started',
      },
      {
        title: 'Connect it',
        summary: 'Paste the bot token',
        meta: '20 sec',
        body: 'Reset the token in the Bot tab, copy it once and paste it here.',
      },
    ],
  },
  telegram: {
    icon: iconTelegram,
    intro:
      'The fastest one. BotFather hands you a single token and your employee is live in chats and groups.',
    phases: [
      {
        title: 'Create the bot',
        summary: 'BotFather does it in one message',
        meta: '30 sec',
        body: 'Send /newbot, pick a display name and a username. BotFather replies with your token.',
        guideLabel: 'Open BotFather',
        guideUrl: 'https://t.me/BotFather',
      },
      {
        title: 'Set privacy',
        summary: 'Decide what it can read',
        meta: '15 sec',
        body: 'Leave privacy on and it only sees replies and mentions. Turn it off and it reads every group message.',
        guideLabel: 'Open Telegram bot guide',
        guideUrl: 'https://core.telegram.org/bots/features#privacy-mode',
      },
      {
        title: 'Connect it',
        summary: 'Paste the token',
        meta: '10 sec',
        body: 'The HTTP token BotFather returned is the only credential Gantry needs.',
      },
    ],
  },
};

export const SLACK_TOKEN_DETAILS: Record<
  string,
  { label: string; path: string; placeholder: string; prefix: string }
> = {
  app_token: {
    label: 'App-level token',
    path: 'Basic Information → App-Level Tokens',
    placeholder: 'xapp-…',
    prefix: 'xapp-',
  },
  bot_token: {
    label: 'Bot user OAuth token',
    path: 'OAuth & Permissions → OAuth Tokens for Your Workspace',
    placeholder: 'xoxb-…',
    prefix: 'xoxb-',
  },
};

export function slackTokenError(key: string, value: string) {
  const detail = SLACK_TOKEN_DETAILS[key];
  const token = value.trim();
  if (!token) return `${detail?.label ?? key} is required.`;
  if (detail && !token.startsWith(detail.prefix))
    return `${detail.label} must start with ${detail.prefix}.`;
  return undefined;
}

export function onboardingChannels(providers: ChannelProvider[]) {
  return CHANNEL_ORDER.flatMap((id) => {
    const provider = providers.find((item) => item.id === id);
    return provider ? [provider] : [];
  });
}

export function onboardingPhases(providerId: string) {
  return (CHANNEL_CONTENT[providerId] ?? CHANNEL_CONTENT.slack).phases;
}
