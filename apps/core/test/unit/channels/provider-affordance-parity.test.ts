import { describe, expect, it } from 'vitest';

import type { PermissionApprovalRequest } from '@core/domain/types.js';
import type { PermissionCardMessageView } from '@core/domain/permission-card.js';
import { PERMISSION_REMEMBER_CODES } from '@core/application/permissions/permission-remember-codec.js';
import {
  discordActionComponents,
  parsePermissionCustomId,
  permissionCustomId,
} from '@core/channels/discord/components.js';
import { prepareDiscordPermissionCardSend } from '@core/channels/discord/prepared-permission-card.js';
import { normalizePermissionAction } from '@core/channels/permission-interaction.js';
import { prepareSlackPermissionCardSend } from '@core/channels/slack/permission-approval-delivery.js';
import {
  SLACK_PERMISSION_DECISION_ACTION_IDS,
  slackPermissionDecisionActionId,
} from '@core/channels/slack/permission-action-id.js';
import {
  buildTeamsApprovalAdaptiveCard,
  buildTeamsMessageCard,
} from '@core/channels/teams/cards.js';
import { readTeamsMessageAction } from '@core/channels/teams/message-actions.js';
import { readTeamsPermissionDecision } from '@core/channels/teams/permission-submit.js';
import {
  parseTelegramPermissionCallbackData,
  telegramPermissionCallbackData,
} from '@core/channels/telegram/channel-shared.js';
import { prepareTelegramPermissionCardSend } from '@core/channels/telegram/prepared-permission-card.js';

const schedulerActions = [
  { kind: 'scheduler_run_now' as const, label: 'Retry now', jobId: 'job-1' },
  {
    kind: 'scheduler_pause_job' as const,
    label: 'Pause job',
    jobId: 'job-1',
  },
];

const scalarDecisionOptions = [
  'allow_once',
  'allow_persistent_rule',
  'cancel',
] as const;

function ineligibleRequest(
  requestId: string,
  overrides: Partial<PermissionApprovalRequest> = {},
): PermissionApprovalRequest {
  return {
    requestId,
    appId: 'default',
    sourceAgentFolder: 'main_agent',
    targetJid: 'provider:conversation-1',
    toolName: 'Bash',
    displayName: 'Terminal',
    decisionReason: 'Run the requested command.',
    risk_level: 'high',
    risk_category: 'filesystem',
    toolInput: { command: 'npm test' },
    suggestions: [
      {
        type: 'addRules',
        behavior: 'allow',
        rules: ['Bash'],
        toolName: 'Bash',
      },
    ],
    decisionOptions: [...scalarDecisionOptions],
    ...overrides,
  };
}

async function renderPermissionCards(
  request: PermissionApprovalRequest,
  providerAlias: string,
): Promise<Record<string, unknown>> {
  const permissionCardView: PermissionCardMessageView = {
    request,
    providerAlias,
  };
  let telegramPayload: unknown;
  await prepareTelegramPermissionCardSend({
    interactionCallbacksEnabled: true,
    bot: {
      api: {
        sendMessage: async (...args: unknown[]) => {
          telegramPayload = args;
          return { message_id: 101 };
        },
      },
    } as never,
    jid: 'tg:100200300',
    options: { permissionCardView },
  }).send();

  let slackPayload: unknown;
  await prepareSlackPermissionCardSend({
    app: {
      client: {
        chat: {
          postMessage: async (payload: unknown) => {
            slackPayload = payload;
            return { ts: '1710000000.000001' };
          },
        },
      },
    } as never,
    channelId: 'C1234567890',
    approverUserIds: ['U1234567890'],
    options: { permissionCardView },
  }).send();

  let discordPayload: unknown;
  await prepareDiscordPermissionCardSend({
    jid: 'dc:1234567890',
    options: { permissionCardView },
    postMessage: async (_channelId, payload) => {
      discordPayload = payload;
      return { id: 'discord-message-1' };
    },
  }).send();

  return {
    telegram: telegramPayload,
    slack: slackPayload,
    discord: discordPayload,
    teams: buildTeamsApprovalAdaptiveCard(request, {
      providerAlias,
      scope: {
        appId: request.appId ?? 'default',
        sourceAgentFolder: request.sourceAgentFolder,
        interactionId: request.requestId,
      },
      matchKind: 'individual',
    }),
  };
}

describe('provider affordance parity', () => {
  it('pins the pre-change ask auto_strict job-prompt and group cards on all four providers', async () => {
    const fixtures = {
      ask: ineligibleRequest('golden-ask'),
      auto_strict: ineligibleRequest('golden-auto-strict'),
      job_prompt: ineligibleRequest('golden-job', {
        permissionLane: 'autonomous',
        jobId: 'job-1',
        jobName: 'Nightly checks',
      }),
      group: ineligibleRequest('golden-group', {
        decisionPolicy: 'same_channel',
        threadId: 'thread-1',
      }),
    };
    const rendered = Object.fromEntries(
      await Promise.all(
        Object.entries(fixtures).map(async ([lane, request]) => [
          lane,
          await renderPermissionCards(request, `callback-${lane}`),
        ]),
      ),
    );

    expect(rendered).toMatchInlineSnapshot(`
      {
        "ask": {
          "discord": {
            "components": [
              {
                "components": [
                  {
                    "custom_id": "gantry:perm_full:callback-ask",
                    "label": "View full command",
                    "style": 2,
                    "type": 2,
                  },
                  {
                    "custom_id": "gantry:perm:callback-ask:allow_once",
                    "label": "Allow once",
                    "style": 1,
                    "type": 2,
                  },
                  {
                    "custom_id": "gantry:perm:callback-ask:allow_persistent_rule",
                    "label": "Allow for future",
                    "style": 1,
                    "type": 2,
                  },
                  {
                    "custom_id": "gantry:perm:callback-ask:cancel",
                    "label": "Cancel",
                    "style": 4,
                    "type": 2,
                  },
                ],
                "type": 1,
              },
            ],
            "content": "🔐 Allow Main Agent to use exact command access?

      Risk: high — filesystem
      Runs: npm

      Agent: Main Agent
      Context: agent chat
      The agent cannot approve this itself.
      Reply in 1440m",
          },
          "slack": {
            "blocks": [
              {
                "text": {
                  "emoji": true,
                  "text": "🔐 Allow Main Agent to use exact command access?",
                  "type": "plain_text",
                },
                "type": "header",
              },
              {
                "text": {
                  "text": "Risk: high — filesystem
      Runs: npm",
                  "type": "mrkdwn",
                },
                "type": "section",
              },
              {
                "elements": [
                  {
                    "text": "Agent: Main Agent
      Context: agent chat
      The agent cannot approve this itself.
      Reply in 1440m",
                    "type": "mrkdwn",
                  },
                ],
                "type": "context",
              },
              {
                "type": "divider",
              },
              {
                "elements": [
                  {
                    "action_id": "gantry_perm_full_view",
                    "text": {
                      "text": "View full command",
                      "type": "plain_text",
                    },
                    "type": "button",
                    "value": "{"callback":{"providerAlias":"callback-ask","scope":{"appId":"default","sourceAgentFolder":"main_agent","interactionId":"golden-ask"},"matchKind":"individual"}}",
                  },
                  {
                    "action_id": "gantry_perm_decision_allow_once",
                    "style": "primary",
                    "text": {
                      "text": "Allow once",
                      "type": "plain_text",
                    },
                    "type": "button",
                    "value": "{"callback":{"providerAlias":"callback-ask","scope":{"appId":"default","sourceAgentFolder":"main_agent","interactionId":"golden-ask"},"matchKind":"individual"},"decision":"allow_once"}",
                  },
                  {
                    "action_id": "gantry_perm_decision_allow_persistent_rule",
                    "style": "primary",
                    "text": {
                      "text": "Allow for future",
                      "type": "plain_text",
                    },
                    "type": "button",
                    "value": "{"callback":{"providerAlias":"callback-ask","scope":{"appId":"default","sourceAgentFolder":"main_agent","interactionId":"golden-ask"},"matchKind":"individual"},"decision":"allow_persistent_rule"}",
                  },
                  {
                    "action_id": "gantry_perm_decision_cancel",
                    "style": "danger",
                    "text": {
                      "text": "Cancel",
                      "type": "plain_text",
                    },
                    "type": "button",
                    "value": "{"callback":{"providerAlias":"callback-ask","scope":{"appId":"default","sourceAgentFolder":"main_agent","interactionId":"golden-ask"},"matchKind":"individual"},"decision":"cancel"}",
                  },
                ],
                "type": "actions",
              },
            ],
            "channel": "C1234567890",
            "text": "🔐 Allow Main Agent to use exact command access?

      Risk: high — filesystem
      Runs: npm

      Agent: Main Agent
      Context: agent chat
      The agent cannot approve this itself.
      Reply in 1440m",
          },
          "teams": {
            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
            "actions": [
              {
                "data": {
                  "action": "permission_decision",
                  "callback": {
                    "matchKind": "individual",
                    "providerAlias": "callback-ask",
                    "scope": {
                      "appId": "default",
                      "interactionId": "golden-ask",
                      "sourceAgentFolder": "main_agent",
                    },
                  },
                  "decision": "allow_once",
                },
                "title": "Allow once",
                "type": "Action.Execute",
                "verb": "gantry.permission.allow",
              },
              {
                "data": {
                  "action": "permission_decision",
                  "callback": {
                    "matchKind": "individual",
                    "providerAlias": "callback-ask",
                    "scope": {
                      "appId": "default",
                      "interactionId": "golden-ask",
                      "sourceAgentFolder": "main_agent",
                    },
                  },
                  "decision": "allow_persistent_rule",
                },
                "title": "Allow for future",
                "type": "Action.Execute",
                "verb": "gantry.permission.allow",
              },
              {
                "data": {
                  "action": "permission_decision",
                  "callback": {
                    "matchKind": "individual",
                    "providerAlias": "callback-ask",
                    "scope": {
                      "appId": "default",
                      "interactionId": "golden-ask",
                      "sourceAgentFolder": "main_agent",
                    },
                  },
                  "decision": "cancel",
                },
                "title": "Cancel",
                "type": "Action.Execute",
                "verb": "gantry.permission.cancel",
              },
            ],
            "body": [
              {
                "size": "Medium",
                "text": "Permission request",
                "type": "TextBlock",
                "weight": "Bolder",
                "wrap": true,
              },
              {
                "text": "🔐 Allow Main Agent to use exact command access?
      Risk: high — filesystem

      Runs: npm
      Command:
      \`\`\`
      npm test
      \`\`\`

      Agent: Main Agent
      Context: agent chat
      The agent cannot approve this itself.
      Reply in 1m",
                "type": "TextBlock",
                "wrap": true,
              },
            ],
            "type": "AdaptiveCard",
            "version": "1.5",
          },
          "telegram": [
            "100200300",
            "<b>🔐 Allow Main Agent to use exact command access?</b>

      Risk: high — filesystem
      Runs: npm

      <i>Agent: Main Agent</i>
      <i>Context: agent chat</i>
      <i>The agent cannot approve this itself.</i>

      <b>View full command</b>
      <blockquote expandable>npm test</blockquote>

      <i>Reply in 1440m</i>",
            {
              "link_preview_options": {
                "is_disabled": true,
              },
              "parse_mode": "HTML",
              "reply_markup": {
                "inline_keyboard": [
                  [
                    {
                      "callback_data": "perm:allow_once:callback-ask",
                      "text": "Allow once",
                    },
                  ],
                  [
                    {
                      "callback_data": "perm:allow_persistent_rule:callback-ask",
                      "text": "Allow for future",
                    },
                  ],
                  [
                    {
                      "callback_data": "perm:cancel:callback-ask",
                      "text": "Cancel",
                    },
                  ],
                ],
              },
            },
          ],
        },
        "auto_strict": {
          "discord": {
            "components": [
              {
                "components": [
                  {
                    "custom_id": "gantry:perm_full:callback-auto_strict",
                    "label": "View full command",
                    "style": 2,
                    "type": 2,
                  },
                  {
                    "custom_id": "gantry:perm:callback-auto_strict:allow_once",
                    "label": "Allow once",
                    "style": 1,
                    "type": 2,
                  },
                  {
                    "custom_id": "gantry:perm:callback-auto_strict:allow_persistent_rule",
                    "label": "Allow for future",
                    "style": 1,
                    "type": 2,
                  },
                  {
                    "custom_id": "gantry:perm:callback-auto_strict:cancel",
                    "label": "Cancel",
                    "style": 4,
                    "type": 2,
                  },
                ],
                "type": 1,
              },
            ],
            "content": "🔐 Allow Main Agent to use exact command access?

      Risk: high — filesystem
      Runs: npm

      Agent: Main Agent
      Context: agent chat
      The agent cannot approve this itself.
      Reply in 1440m",
          },
          "slack": {
            "blocks": [
              {
                "text": {
                  "emoji": true,
                  "text": "🔐 Allow Main Agent to use exact command access?",
                  "type": "plain_text",
                },
                "type": "header",
              },
              {
                "text": {
                  "text": "Risk: high — filesystem
      Runs: npm",
                  "type": "mrkdwn",
                },
                "type": "section",
              },
              {
                "elements": [
                  {
                    "text": "Agent: Main Agent
      Context: agent chat
      The agent cannot approve this itself.
      Reply in 1440m",
                    "type": "mrkdwn",
                  },
                ],
                "type": "context",
              },
              {
                "type": "divider",
              },
              {
                "elements": [
                  {
                    "action_id": "gantry_perm_full_view",
                    "text": {
                      "text": "View full command",
                      "type": "plain_text",
                    },
                    "type": "button",
                    "value": "{"callback":{"providerAlias":"callback-auto_strict","scope":{"appId":"default","sourceAgentFolder":"main_agent","interactionId":"golden-auto-strict"},"matchKind":"individual"}}",
                  },
                  {
                    "action_id": "gantry_perm_decision_allow_once",
                    "style": "primary",
                    "text": {
                      "text": "Allow once",
                      "type": "plain_text",
                    },
                    "type": "button",
                    "value": "{"callback":{"providerAlias":"callback-auto_strict","scope":{"appId":"default","sourceAgentFolder":"main_agent","interactionId":"golden-auto-strict"},"matchKind":"individual"},"decision":"allow_once"}",
                  },
                  {
                    "action_id": "gantry_perm_decision_allow_persistent_rule",
                    "style": "primary",
                    "text": {
                      "text": "Allow for future",
                      "type": "plain_text",
                    },
                    "type": "button",
                    "value": "{"callback":{"providerAlias":"callback-auto_strict","scope":{"appId":"default","sourceAgentFolder":"main_agent","interactionId":"golden-auto-strict"},"matchKind":"individual"},"decision":"allow_persistent_rule"}",
                  },
                  {
                    "action_id": "gantry_perm_decision_cancel",
                    "style": "danger",
                    "text": {
                      "text": "Cancel",
                      "type": "plain_text",
                    },
                    "type": "button",
                    "value": "{"callback":{"providerAlias":"callback-auto_strict","scope":{"appId":"default","sourceAgentFolder":"main_agent","interactionId":"golden-auto-strict"},"matchKind":"individual"},"decision":"cancel"}",
                  },
                ],
                "type": "actions",
              },
            ],
            "channel": "C1234567890",
            "text": "🔐 Allow Main Agent to use exact command access?

      Risk: high — filesystem
      Runs: npm

      Agent: Main Agent
      Context: agent chat
      The agent cannot approve this itself.
      Reply in 1440m",
          },
          "teams": {
            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
            "actions": [
              {
                "data": {
                  "action": "permission_decision",
                  "callback": {
                    "matchKind": "individual",
                    "providerAlias": "callback-auto_strict",
                    "scope": {
                      "appId": "default",
                      "interactionId": "golden-auto-strict",
                      "sourceAgentFolder": "main_agent",
                    },
                  },
                  "decision": "allow_once",
                },
                "title": "Allow once",
                "type": "Action.Execute",
                "verb": "gantry.permission.allow",
              },
              {
                "data": {
                  "action": "permission_decision",
                  "callback": {
                    "matchKind": "individual",
                    "providerAlias": "callback-auto_strict",
                    "scope": {
                      "appId": "default",
                      "interactionId": "golden-auto-strict",
                      "sourceAgentFolder": "main_agent",
                    },
                  },
                  "decision": "allow_persistent_rule",
                },
                "title": "Allow for future",
                "type": "Action.Execute",
                "verb": "gantry.permission.allow",
              },
              {
                "data": {
                  "action": "permission_decision",
                  "callback": {
                    "matchKind": "individual",
                    "providerAlias": "callback-auto_strict",
                    "scope": {
                      "appId": "default",
                      "interactionId": "golden-auto-strict",
                      "sourceAgentFolder": "main_agent",
                    },
                  },
                  "decision": "cancel",
                },
                "title": "Cancel",
                "type": "Action.Execute",
                "verb": "gantry.permission.cancel",
              },
            ],
            "body": [
              {
                "size": "Medium",
                "text": "Permission request",
                "type": "TextBlock",
                "weight": "Bolder",
                "wrap": true,
              },
              {
                "text": "🔐 Allow Main Agent to use exact command access?
      Risk: high — filesystem

      Runs: npm
      Command:
      \`\`\`
      npm test
      \`\`\`

      Agent: Main Agent
      Context: agent chat
      The agent cannot approve this itself.
      Reply in 1m",
                "type": "TextBlock",
                "wrap": true,
              },
            ],
            "type": "AdaptiveCard",
            "version": "1.5",
          },
          "telegram": [
            "100200300",
            "<b>🔐 Allow Main Agent to use exact command access?</b>

      Risk: high — filesystem
      Runs: npm

      <i>Agent: Main Agent</i>
      <i>Context: agent chat</i>
      <i>The agent cannot approve this itself.</i>

      <b>View full command</b>
      <blockquote expandable>npm test</blockquote>

      <i>Reply in 1440m</i>",
            {
              "link_preview_options": {
                "is_disabled": true,
              },
              "parse_mode": "HTML",
              "reply_markup": {
                "inline_keyboard": [
                  [
                    {
                      "callback_data": "perm:allow_once:callback-auto_strict",
                      "text": "Allow once",
                    },
                  ],
                  [
                    {
                      "callback_data": "perm:allow_persistent_rule:callback-auto_strict",
                      "text": "Allow for future",
                    },
                  ],
                  [
                    {
                      "callback_data": "perm:cancel:callback-auto_strict",
                      "text": "Cancel",
                    },
                  ],
                ],
              },
            },
          ],
        },
        "group": {
          "discord": {
            "components": [
              {
                "components": [
                  {
                    "custom_id": "gantry:perm_full:callback-group",
                    "label": "View full command",
                    "style": 2,
                    "type": 2,
                  },
                  {
                    "custom_id": "gantry:perm:callback-group:allow_once",
                    "label": "Allow once",
                    "style": 1,
                    "type": 2,
                  },
                  {
                    "custom_id": "gantry:perm:callback-group:allow_persistent_rule",
                    "label": "Allow for future",
                    "style": 1,
                    "type": 2,
                  },
                  {
                    "custom_id": "gantry:perm:callback-group:cancel",
                    "label": "Cancel",
                    "style": 4,
                    "type": 2,
                  },
                ],
                "type": 1,
              },
            ],
            "content": "🔐 Allow Main Agent to use exact command access?

      Risk: high — filesystem
      Runs: npm

      Agent: Main Agent
      Context: agent chat
      Approval applies to the parent conversation.
      The agent cannot approve this itself.
      Reply in 1440m",
          },
          "slack": {
            "blocks": [
              {
                "text": {
                  "emoji": true,
                  "text": "🔐 Allow Main Agent to use exact command access?",
                  "type": "plain_text",
                },
                "type": "header",
              },
              {
                "text": {
                  "text": "Risk: high — filesystem
      Runs: npm",
                  "type": "mrkdwn",
                },
                "type": "section",
              },
              {
                "elements": [
                  {
                    "text": "Agent: Main Agent
      Context: agent chat
      Approval applies to the parent conversation.
      The agent cannot approve this itself.
      Reply in 1440m",
                    "type": "mrkdwn",
                  },
                ],
                "type": "context",
              },
              {
                "type": "divider",
              },
              {
                "elements": [
                  {
                    "action_id": "gantry_perm_full_view",
                    "text": {
                      "text": "View full command",
                      "type": "plain_text",
                    },
                    "type": "button",
                    "value": "{"callback":{"providerAlias":"callback-group","scope":{"appId":"default","sourceAgentFolder":"main_agent","interactionId":"golden-group"},"matchKind":"individual"}}",
                  },
                  {
                    "action_id": "gantry_perm_decision_allow_once",
                    "style": "primary",
                    "text": {
                      "text": "Allow once",
                      "type": "plain_text",
                    },
                    "type": "button",
                    "value": "{"callback":{"providerAlias":"callback-group","scope":{"appId":"default","sourceAgentFolder":"main_agent","interactionId":"golden-group"},"matchKind":"individual"},"decision":"allow_once"}",
                  },
                  {
                    "action_id": "gantry_perm_decision_allow_persistent_rule",
                    "style": "primary",
                    "text": {
                      "text": "Allow for future",
                      "type": "plain_text",
                    },
                    "type": "button",
                    "value": "{"callback":{"providerAlias":"callback-group","scope":{"appId":"default","sourceAgentFolder":"main_agent","interactionId":"golden-group"},"matchKind":"individual"},"decision":"allow_persistent_rule"}",
                  },
                  {
                    "action_id": "gantry_perm_decision_cancel",
                    "style": "danger",
                    "text": {
                      "text": "Cancel",
                      "type": "plain_text",
                    },
                    "type": "button",
                    "value": "{"callback":{"providerAlias":"callback-group","scope":{"appId":"default","sourceAgentFolder":"main_agent","interactionId":"golden-group"},"matchKind":"individual"},"decision":"cancel"}",
                  },
                ],
                "type": "actions",
              },
            ],
            "channel": "C1234567890",
            "text": "🔐 Allow Main Agent to use exact command access?

      Risk: high — filesystem
      Runs: npm

      Agent: Main Agent
      Context: agent chat
      Approval applies to the parent conversation.
      The agent cannot approve this itself.
      Reply in 1440m",
          },
          "teams": {
            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
            "actions": [
              {
                "data": {
                  "action": "permission_decision",
                  "callback": {
                    "matchKind": "individual",
                    "providerAlias": "callback-group",
                    "scope": {
                      "appId": "default",
                      "interactionId": "golden-group",
                      "sourceAgentFolder": "main_agent",
                    },
                  },
                  "decision": "allow_once",
                },
                "title": "Allow once",
                "type": "Action.Execute",
                "verb": "gantry.permission.allow",
              },
              {
                "data": {
                  "action": "permission_decision",
                  "callback": {
                    "matchKind": "individual",
                    "providerAlias": "callback-group",
                    "scope": {
                      "appId": "default",
                      "interactionId": "golden-group",
                      "sourceAgentFolder": "main_agent",
                    },
                  },
                  "decision": "allow_persistent_rule",
                },
                "title": "Allow for future",
                "type": "Action.Execute",
                "verb": "gantry.permission.allow",
              },
              {
                "data": {
                  "action": "permission_decision",
                  "callback": {
                    "matchKind": "individual",
                    "providerAlias": "callback-group",
                    "scope": {
                      "appId": "default",
                      "interactionId": "golden-group",
                      "sourceAgentFolder": "main_agent",
                    },
                  },
                  "decision": "cancel",
                },
                "title": "Cancel",
                "type": "Action.Execute",
                "verb": "gantry.permission.cancel",
              },
            ],
            "body": [
              {
                "size": "Medium",
                "text": "Permission request",
                "type": "TextBlock",
                "weight": "Bolder",
                "wrap": true,
              },
              {
                "text": "🔐 Allow Main Agent to use exact command access?
      Risk: high — filesystem

      Runs: npm
      Command:
      \`\`\`
      npm test
      \`\`\`

      Agent: Main Agent
      Context: agent chat
      Approval applies to the parent conversation.
      The agent cannot approve this itself.
      Reply in 1m",
                "type": "TextBlock",
                "wrap": true,
              },
            ],
            "type": "AdaptiveCard",
            "version": "1.5",
          },
          "telegram": [
            "100200300",
            "<b>🔐 Allow Main Agent to use exact command access?</b>

      Risk: high — filesystem
      Runs: npm

      <i>Agent: Main Agent</i>
      <i>Context: agent chat</i>
      <i>Approval applies to the parent conversation.</i>
      <i>The agent cannot approve this itself.</i>

      <b>View full command</b>
      <blockquote expandable>npm test</blockquote>

      <i>Reply in 1440m</i>",
            {
              "link_preview_options": {
                "is_disabled": true,
              },
              "parse_mode": "HTML",
              "reply_markup": {
                "inline_keyboard": [
                  [
                    {
                      "callback_data": "perm:allow_once:callback-group",
                      "text": "Allow once",
                    },
                  ],
                  [
                    {
                      "callback_data": "perm:allow_persistent_rule:callback-group",
                      "text": "Allow for future",
                    },
                  ],
                  [
                    {
                      "callback_data": "perm:cancel:callback-group",
                      "text": "Cancel",
                    },
                  ],
                ],
              },
            },
          ],
        },
        "job_prompt": {
          "discord": {
            "components": [
              {
                "components": [
                  {
                    "custom_id": "gantry:perm_full:callback-job_prompt",
                    "label": "View full command",
                    "style": 2,
                    "type": 2,
                  },
                  {
                    "custom_id": "gantry:perm:callback-job_prompt:allow_once",
                    "label": "Allow once",
                    "style": 1,
                    "type": 2,
                  },
                  {
                    "custom_id": "gantry:perm:callback-job_prompt:allow_persistent_rule",
                    "label": "Allow for future",
                    "style": 1,
                    "type": 2,
                  },
                  {
                    "custom_id": "gantry:perm:callback-job_prompt:cancel",
                    "label": "Cancel",
                    "style": 4,
                    "type": 2,
                  },
                ],
                "type": 1,
              },
            ],
            "content": "🔐 Allow Main Agent to use exact command access?

      Risk: high — filesystem
      Runs: npm

      Agent: Main Agent
      Context: scheduled job: Nightly checks
      The agent cannot approve this itself.
      This request stays open until you decide.",
          },
          "slack": {
            "blocks": [
              {
                "text": {
                  "emoji": true,
                  "text": "🔐 Allow Main Agent to use exact command access?",
                  "type": "plain_text",
                },
                "type": "header",
              },
              {
                "text": {
                  "text": "Risk: high — filesystem
      Runs: npm",
                  "type": "mrkdwn",
                },
                "type": "section",
              },
              {
                "elements": [
                  {
                    "text": "Agent: Main Agent
      Context: scheduled job: Nightly checks
      The agent cannot approve this itself.
      Reply in 1440m",
                    "type": "mrkdwn",
                  },
                ],
                "type": "context",
              },
              {
                "type": "divider",
              },
              {
                "elements": [
                  {
                    "action_id": "gantry_perm_full_view",
                    "text": {
                      "text": "View full command",
                      "type": "plain_text",
                    },
                    "type": "button",
                    "value": "{"callback":{"providerAlias":"callback-job_prompt","scope":{"appId":"default","sourceAgentFolder":"main_agent","interactionId":"golden-job"},"matchKind":"individual"}}",
                  },
                  {
                    "action_id": "gantry_perm_decision_allow_once",
                    "style": "primary",
                    "text": {
                      "text": "Allow once",
                      "type": "plain_text",
                    },
                    "type": "button",
                    "value": "{"callback":{"providerAlias":"callback-job_prompt","scope":{"appId":"default","sourceAgentFolder":"main_agent","interactionId":"golden-job"},"matchKind":"individual"},"decision":"allow_once"}",
                  },
                  {
                    "action_id": "gantry_perm_decision_allow_persistent_rule",
                    "style": "primary",
                    "text": {
                      "text": "Allow for future",
                      "type": "plain_text",
                    },
                    "type": "button",
                    "value": "{"callback":{"providerAlias":"callback-job_prompt","scope":{"appId":"default","sourceAgentFolder":"main_agent","interactionId":"golden-job"},"matchKind":"individual"},"decision":"allow_persistent_rule"}",
                  },
                  {
                    "action_id": "gantry_perm_decision_cancel",
                    "style": "danger",
                    "text": {
                      "text": "Cancel",
                      "type": "plain_text",
                    },
                    "type": "button",
                    "value": "{"callback":{"providerAlias":"callback-job_prompt","scope":{"appId":"default","sourceAgentFolder":"main_agent","interactionId":"golden-job"},"matchKind":"individual"},"decision":"cancel"}",
                  },
                ],
                "type": "actions",
              },
            ],
            "channel": "C1234567890",
            "text": "🔐 Allow Main Agent to use exact command access?

      Risk: high — filesystem
      Runs: npm

      Agent: Main Agent
      Context: scheduled job: Nightly checks
      The agent cannot approve this itself.
      This request stays open until you decide.",
          },
          "teams": {
            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
            "actions": [
              {
                "data": {
                  "action": "permission_decision",
                  "callback": {
                    "matchKind": "individual",
                    "providerAlias": "callback-job_prompt",
                    "scope": {
                      "appId": "default",
                      "interactionId": "golden-job",
                      "sourceAgentFolder": "main_agent",
                    },
                  },
                  "decision": "allow_once",
                },
                "title": "Allow once",
                "type": "Action.Execute",
                "verb": "gantry.permission.allow",
              },
              {
                "data": {
                  "action": "permission_decision",
                  "callback": {
                    "matchKind": "individual",
                    "providerAlias": "callback-job_prompt",
                    "scope": {
                      "appId": "default",
                      "interactionId": "golden-job",
                      "sourceAgentFolder": "main_agent",
                    },
                  },
                  "decision": "allow_persistent_rule",
                },
                "title": "Allow for future",
                "type": "Action.Execute",
                "verb": "gantry.permission.allow",
              },
              {
                "data": {
                  "action": "permission_decision",
                  "callback": {
                    "matchKind": "individual",
                    "providerAlias": "callback-job_prompt",
                    "scope": {
                      "appId": "default",
                      "interactionId": "golden-job",
                      "sourceAgentFolder": "main_agent",
                    },
                  },
                  "decision": "cancel",
                },
                "title": "Cancel",
                "type": "Action.Execute",
                "verb": "gantry.permission.cancel",
              },
            ],
            "body": [
              {
                "size": "Medium",
                "text": "Permission request",
                "type": "TextBlock",
                "weight": "Bolder",
                "wrap": true,
              },
              {
                "text": "🔐 Allow Main Agent to use exact command access?
      Risk: high — filesystem

      Runs: npm
      Command:
      \`\`\`
      npm test
      \`\`\`

      Agent: Main Agent
      Context: scheduled job: Nightly checks
      The agent cannot approve this itself.
      This request stays open until you decide.",
                "type": "TextBlock",
                "wrap": true,
              },
            ],
            "type": "AdaptiveCard",
            "version": "1.5",
          },
          "telegram": [
            "100200300",
            "<b>🔐 Allow Main Agent to use exact command access?</b>

      Risk: high — filesystem
      Runs: npm

      <i>Agent: Main Agent</i>
      <i>Context: scheduled job: Nightly checks</i>
      <i>The agent cannot approve this itself.</i>

      <b>View full command</b>
      <blockquote expandable>npm test</blockquote>

      <i>This request stays open until you decide.</i>",
            {
              "link_preview_options": {
                "is_disabled": true,
              },
              "parse_mode": "HTML",
              "reply_markup": {
                "inline_keyboard": [
                  [
                    {
                      "callback_data": "perm:allow_once:callback-job_prompt",
                      "text": "Allow once",
                    },
                  ],
                  [
                    {
                      "callback_data": "perm:allow_persistent_rule:callback-job_prompt",
                      "text": "Allow for future",
                    },
                  ],
                  [
                    {
                      "callback_data": "perm:cancel:callback-job_prompt",
                      "text": "Cancel",
                    },
                  ],
                ],
              },
            },
          ],
        },
      }
    `);
  });

  it('discord and teams render the neutral scheduler kind set or a visible text fallback', () => {
    const discord = discordActionComponents({
      actionAffordances: schedulerActions,
    }) as Array<{
      components: Array<{ custom_id: string; label: string }>;
    }>;
    expect(discord.flatMap((row) => row.components)).toEqual([
      expect.objectContaining({
        custom_id: 'gantry:scheduler_run_now:job-1',
      }),
      expect.objectContaining({
        custom_id: 'gantry:scheduler_pause_job:job-1',
        label: 'Pause job',
      }),
    ]);

    const teams = buildTeamsMessageCard({
      text: 'Job needs attention.',
      targetJid: 'teams:conversation-1',
      threadId: 'thread-1',
      actionAffordances: schedulerActions,
    });
    expect(teams.actions).toHaveLength(2);
    expect(teams.actions[1]).toMatchObject({ title: 'Pause job' });
    expect(
      teams.actions.map((action) => readTeamsMessageAction(action.data)),
    ).toEqual([
      expect.objectContaining({ kind: 'scheduler_run_now', jobId: 'job-1' }),
      expect.objectContaining({ kind: 'scheduler_pause_job', jobId: 'job-1' }),
    ]);
  });

  it('renders scheduler_retry_ask on discord and teams like the other scheduler kinds', () => {
    const retryAsk = [
      {
        kind: 'scheduler_retry_ask' as const,
        label: 'Allow once for this run',
        jobId: 'job-1',
      },
    ];
    const discord = discordActionComponents({
      actionAffordances: retryAsk,
    }) as Array<{
      components: Array<{ custom_id: string; label: string }>;
    }>;
    expect(discord.flatMap((row) => row.components)).toEqual([
      expect.objectContaining({
        custom_id: 'gantry:scheduler_retry_ask:job-1',
        label: 'Allow once for this run',
      }),
    ]);
    const teams = buildTeamsMessageCard({
      text: 'Job needs attention.',
      targetJid: 'teams:conversation-1',
      threadId: 'thread-1',
      actionAffordances: retryAsk,
    });
    expect(teams.actions).toHaveLength(1);
    expect(teams.actions[0]).toMatchObject({
      title: 'Allow once for this run',
      verb: 'gantry.scheduler.retry_ask',
    });
    expect(readTeamsMessageAction(teams.actions[0].data)).toMatchObject({
      kind: 'scheduler_retry_ask',
      jobId: 'job-1',
    });
  });

  it('splits and caps Discord scheduler affordances at five rows of five', () => {
    const discord = discordActionComponents({
      actionAffordances: Array.from({ length: 30 }, (_, index) => ({
        kind: 'scheduler_run_now' as const,
        label: `Retry ${index + 1}`,
        jobId: `job-${index + 1}`,
      })),
    }) as Array<{ components: unknown[] }>;

    expect(discord.map((row) => row.components)).toHaveLength(5);
    expect(discord[0]?.components).toHaveLength(5);
    expect(discord[4]?.components).toHaveLength(5);
  });

  it('permission prompt affordances round-trip on slack, telegram, discord, and teams', () => {
    const modes = ['allow_once', 'allow_persistent_rule', 'cancel'] as const;
    const request = {
      requestId: 'request-1',
      appId: 'default',
      agentId: 'main_agent',
      sourceAgentFolder: 'main_agent',
      targetJid: 'teams:conversation-1',
      toolName: 'Browser',
      displayName: 'Browser',
      title: 'Approve Browser',
      description: 'Browser access is required.',
      decisionReason: 'Run the scheduled job.',
      toolInput: {},
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: ['Browser'],
          toolName: 'Browser',
        },
      ],
      decisionOptions: [...modes],
    } as PermissionApprovalRequest;

    expect(
      modes.map((mode) =>
        normalizePermissionAction(
          slackPermissionDecisionActionId(mode).replace(
            'gantry_perm_decision_',
            '',
          ),
        ),
      ),
    ).toEqual(modes);
    expect(
      modes.map(
        (mode) =>
          parseTelegramPermissionCallbackData(
            telegramPermissionCallbackData(mode, 'callback-1'),
          )?.mode,
      ),
    ).toEqual(modes);
    expect(
      modes.map(
        (mode) =>
          parsePermissionCustomId(permissionCustomId('callback-1', mode))?.mode,
      ),
    ).toEqual(modes);

    const teams = buildTeamsApprovalAdaptiveCard(request, {
      providerAlias: 'callback-1',
      scope: {
        appId: 'default',
        sourceAgentFolder: 'main_agent',
        interactionId: 'request-1',
      },
      matchKind: 'individual',
    });
    expect(
      teams.actions.map(
        (action) => readTeamsPermissionDecision(action.data)?.decision,
      ),
    ).toEqual(modes);
  });

  it('round-trips all four remember codes and all three scalar modes through the Telegram and Slack codecs including Slack action-id registration and the Telegram 64-byte maximum', () => {
    const values = [
      'allow_once',
      'allow_persistent_rule',
      'cancel',
      ...PERMISSION_REMEMBER_CODES,
    ] as const;
    const callbackId = '12345678-1234-1234-1234-123456789012';

    for (const value of values) {
      const telegram = telegramPermissionCallbackData(value, callbackId);
      expect(Buffer.byteLength(telegram)).toBeLessThanOrEqual(64);
      expect(parseTelegramPermissionCallbackData(telegram)).toEqual({
        mode: value,
        callbackId,
      });

      const slack = slackPermissionDecisionActionId(value);
      expect(SLACK_PERMISSION_DECISION_ACTION_IDS).toContain(slack);
      expect(slack.slice('gantry_perm_decision_'.length)).toBe(value);
    }
  });
});
