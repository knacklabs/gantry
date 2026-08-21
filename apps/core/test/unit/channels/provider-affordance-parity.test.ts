import { describe, expect, it } from 'vitest';

import type { PermissionApprovalRequest } from '@core/domain/types.js';
import {
  discordActionComponents,
  parsePermissionCustomId,
  permissionCustomId,
} from '@core/channels/discord-components.js';
import { normalizePermissionAction } from '@core/channels/permission-interaction.js';
import { slackPermissionDecisionActionId } from '@core/channels/slack/permission-action-id.js';
import {
  buildTeamsApprovalAdaptiveCard,
  buildTeamsMessageCard,
} from '@core/channels/teams-cards.js';
import { readTeamsMessageAction } from '@core/channels/teams-message-actions.js';
import { readTeamsPermissionDecision } from '@core/channels/teams-permission-submit.js';
import {
  parseTelegramPermissionCallbackData,
  telegramPermissionCallbackData,
} from '@core/channels/telegram/channel-shared.js';

const schedulerActions = [
  { kind: 'scheduler_run_now' as const, label: 'Retry now', jobId: 'job-1' },
  {
    kind: 'scheduler_pause_job' as const,
    label: 'Pause job',
    jobId: 'job-1',
  },
];

describe('provider affordance parity', () => {
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
        label: 'How to pause',
      }),
    ]);

    const teams = buildTeamsMessageCard({
      text: 'Job needs attention.',
      targetJid: 'teams:conversation-1',
      threadId: 'thread-1',
      actionAffordances: schedulerActions,
    });
    expect(teams.actions).toHaveLength(2);
    expect(teams.actions[1]).toMatchObject({ title: 'How to pause' });
    expect(
      teams.actions.map((action) => readTeamsMessageAction(action.data)),
    ).toEqual([
      expect.objectContaining({ kind: 'scheduler_run_now', jobId: 'job-1' }),
      expect.objectContaining({ kind: 'scheduler_pause_job', jobId: 'job-1' }),
    ]);
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
});
