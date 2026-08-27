import { describe, expect, it } from 'vitest';

import { PromptProfileService } from '@core/application/agents/prompt-profile-service.js';
import { MAX_MESSAGE_FILE_ATTACHMENT_BYTES } from '@core/application/core-tools/message-limits.js';
import {
  listChannelProviders,
  renderChannelPromptPresentation,
} from '@core/channels/provider-registry.js';
import { DISCORD_MESSAGE_MAX_LENGTH } from '@core/channels/discord/limits.js';
import { SLACK_FALLBACK_CHUNK_MAX_LENGTH } from '@core/channels/slack/text-limits.js';
import {
  TEAMS_HARD_MESSAGE_BYTES,
  TEAMS_SOFT_MESSAGE_BYTES,
} from '@core/channels/teams/limits.js';
import { TELEGRAM_MESSAGE_MAX_LENGTH } from '@core/channels/telegram/text-limits.js';
import '@core/channels/register-builtins.js';

describe('channel prompt presentation', () => {
  it('renders provider tool guidance from imported limit constants', async () => {
    const service = new PromptProfileService();
    const cases = [
      {
        jid: 'tg:123',
        marker: 'Telegram HTML plus inline keyboards',
        limits: [TELEGRAM_MESSAGE_MAX_LENGTH],
      },
      {
        jid: 'sl:C123',
        marker: 'Block Kit',
        limits: [SLACK_FALLBACK_CHUNK_MAX_LENGTH],
      },
      {
        jid: 'teams:conversation',
        marker: 'Adaptive Card',
        limits: [TEAMS_SOFT_MESSAGE_BYTES, TEAMS_HARD_MESSAGE_BYTES],
      },
      {
        jid: 'dc:123',
        marker: 'single embed',
        limits: [DISCORD_MESSAGE_MAX_LENGTH],
      },
      {
        jid: 'app:session',
        marker: 'structured app descriptor',
        limits: [],
      },
    ] as const;
    const markers = cases.map(({ marker }) => marker);

    for (const testCase of cases) {
      const channelContextLine = renderChannelPromptPresentation(
        testCase.jid,
        'channel',
      );
      const prompt = await service.compileSystemPrompt({
        agentFolder: 'provider-guidance-test',
        runtimeContext: { channelContextLine },
      });

      expect(prompt).toContain(testCase.marker);
      expect(prompt).toContain(String(MAX_MESSAGE_FILE_ATTACHMENT_BYTES));
      for (const limit of testCase.limits) {
        expect(prompt).toContain(String(limit));
      }
      for (const otherMarker of markers.filter(
        (marker) => marker !== testCase.marker,
      )) {
        expect(prompt).not.toContain(otherMarker);
      }
      if (testCase.jid.startsWith('sl:')) {
        expect(prompt).toContain(
          'canvas_read, canvas_create, and canvas_update',
        );
        expect(prompt).toContain('Read first, keep the returned handle');
      } else {
        expect(prompt).not.toContain('canvas');
      }
    }

    for (const provider of listChannelProviders()) {
      const rendered = renderChannelPromptPresentation(
        `${provider.jidPrefix}guidance-test`,
        'channel',
      );
      expect(rendered?.split('\n')).toHaveLength(
        1 + (provider.promptPresentation?.toolGuidance.length ?? 0),
      );
      expect(rendered?.split('\n').length).toBeLessThanOrEqual(10);
    }
  });
});
