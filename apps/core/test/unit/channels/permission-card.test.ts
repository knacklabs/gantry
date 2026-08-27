import { describe, expect, it, vi } from 'vitest';

import { buildBoundedPermissionCard } from '@core/channels/permission-card.js';
import { DiscordChannel } from '@core/channels/discord/index.js';
import { DiscordInteractionHandler } from '@core/channels/discord/interactions.js';
import { SlackChannel } from '@core/channels/slack/channel-adapter.js';
import { prepareSlackPermissionCardSend } from '@core/channels/slack/permission-approval-delivery.js';
import { TeamsChannel } from '@core/channels/teams.js';
import { prepareTeamsPermissionCardSend } from '@core/channels/teams-permission-approval.js';
import { TelegramChannel } from '@core/channels/telegram/channel-adapter.js';

describe('bounded permission cards', () => {
  const view = {
    providerAlias: 'alias:1',
    request: {
      requestId: 'request:1',
      appId: 'default',
      sourceAgentFolder: 'main_agent',
      toolName: 'RunCommand',
      decisionOptions: ['allow_once', 'cancel'] as const,
    },
  };

  it('exposes the non-waiting prepared-send port on all four adapters', () => {
    for (const adapter of [
      TelegramChannel,
      SlackChannel,
      TeamsChannel,
      DiscordChannel,
    ]) {
      expect(adapter.prototype.preparePermissionCardSend).toBeTypeOf(
        'function',
      );
    }
  });

  it('bounds oversized content and directs overflow to pending approvals', () => {
    const card = buildBoundedPermissionCard({
      providerAlias: 'alias:1',
      request: {
        requestId: 'request:1',
        sourceAgentFolder: 'main_agent',
        toolName: 'RunCommand',
        toolInput: { command: `npm run task -- ${'x'.repeat(10_000)}` },
        closestRule: {
          rule: `RunCommand(${'x'.repeat(10_000)})`,
          reason: 'A similarly broad command was previously allowed.',
        },
      },
      fullView: {
        label: 'View full command',
        title: 'Full command',
        filename: 'command.txt',
        content: 'x'.repeat(10_000),
      },
    });

    expect(card.text.length).toBeLessThanOrEqual(1_600);
    expect(card.parts.fullView?.content).toContain('pending approvals list');
    expect(card.parts.fullView?.content.length).toBeLessThanOrEqual(500);
    expect(card.parts.fullView?.label.length).toBeLessThanOrEqual(80);
  });

  it('invokes exactly one provider message call per prepared adapter send', async () => {
    const telegramSend = vi.fn(async () => ({ message_id: 11 }));
    const telegramPrepared =
      TelegramChannel.prototype.preparePermissionCardSend.call(
        {
          interactionCallbacksEnabled: true,
          bot: { api: { sendMessage: telegramSend } },
        },
        'tg:123',
        'Approval required',
        { permissionCardView: view as any },
      );
    await telegramPrepared.send();
    expect(telegramSend).toHaveBeenCalledOnce();

    const slackPost = vi.fn(async () => ({ ts: '12' }));
    await prepareSlackPermissionCardSend({
      app: { client: { chat: { postMessage: slackPost } } } as any,
      channelId: 'C123',
      approverUserIds: ['U1'],
      options: { permissionCardView: view as any },
    }).send();
    expect(slackPost).toHaveBeenCalledOnce();

    const teamsSend = vi.fn(async () => ({ externalMessageId: '13' }));
    await prepareTeamsPermissionCardSend({
      connected: true,
      jid: 'teams:conversation-1',
      options: { permissionCardView: view as any },
      sdkClient: { sendAdaptiveCard: teamsSend } as any,
    }).send();
    expect(teamsSend).toHaveBeenCalledOnce();

    const teamsFullViewSend = vi.fn(async () => ({ externalMessageId: '13b' }));
    await prepareTeamsPermissionCardSend({
      connected: true,
      jid: 'teams:conversation-1',
      options: {
        permissionCardView: {
          ...view,
          fullView: {
            label: 'View command',
            title: 'Command',
            filename: 'command.txt',
            content: 'npm run task',
          },
        } as any,
      },
      sdkClient: { sendAdaptiveCard: teamsFullViewSend } as any,
    }).send();
    expect(teamsFullViewSend).toHaveBeenCalledWith(
      expect.objectContaining({
        card: expect.objectContaining({
          actions: expect.arrayContaining([
            expect.objectContaining({ type: 'Action.ShowCard' }),
          ]),
        }),
      }),
    );

    const discordPost = vi.fn(async () => ({ id: '14' }));
    const discordPrepared =
      DiscordInteractionHandler.prototype.preparePermissionCardSend.call(
        { input: { postMessage: discordPost } },
        'dc:channel-1',
        'Approval required',
        { permissionCardView: view as any },
      );
    await discordPrepared.send();
    expect(discordPost).toHaveBeenCalledOnce();
  });
});
