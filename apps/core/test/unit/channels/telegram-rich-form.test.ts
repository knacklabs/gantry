import { describe, expect, it, vi } from 'vitest';
import { TelegramRichFormSessions } from '@core/channels/telegram/rich-form-session.js';
import { renderTelegramRichInteraction } from '@core/channels/telegram/rich-interaction.js';
import { normalizeTelegramPrivateCommand } from '@core/channels/telegram/text-message-handler.js';
import { extractSessionCommand } from '@core/session/session-commands.js';
import type { RichInteractionRequest } from '@core/domain/types.js';

const request: RichInteractionRequest = {
  requestId: 'claim-intake-1',
  sourceAgentFolder: 'mia',
  descriptor: {
    id: 'claim-form-1',
    title: 'New motor claim',
    rich: {
      kind: 'form',
      fallbackText: 'Please provide your claim details.',
      payload: {
        fields: [
          { id: 'policy', label: 'Policy ID', required: true },
          { id: 'incident', label: 'Incident type', required: true },
        ],
      },
    },
  },
};

describe('Telegram guided form', () => {
  it('maps private !new to Gantry’s real session reset command', () => {
    const content = normalizeTelegramPrivateCommand('!new', true);
    expect(extractSessionCommand(content, /@MIA\b/i)).toEqual({
      kind: 'new',
      raw: '/new',
    });
    expect(normalizeTelegramPrivateCommand('!new', false)).toBe('!new');
  });
  it('uses ForceReply and submits all answers as one agent turn', async () => {
    const sessions = new TelegramRichFormSessions();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 10 })
      .mockResolvedValueOnce({ message_id: 11 });
    const rendered = await renderTelegramRichInteraction({
      bot: { api: { sendMessage } },
      jid: 'tg:123',
      render: request,
      formSessions: sessions,
      sendFallback: vi.fn(),
    });
    expect(rendered).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      '123',
      expect.stringContaining('Policy ID'),
      expect.objectContaining({
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Policy ID',
        },
      }),
    );
    expect(
      await sessions.answer({
        chatId: '123',
        replyToMessageId: 10,
        userId: 'u1',
        text: 'MOTOR-1001',
        sendPrompt: async (text) => {
          expect(text).toContain('Incident type');
          return 11;
        },
      }),
    ).toEqual({ handled: true });
    expect(
      await sessions.answer({
        chatId: '123',
        replyToMessageId: 11,
        userId: 'u1',
        text: 'collision',
        sendPrompt: vi.fn(),
      }),
    ).toEqual({
      handled: true,
      submission:
        'Form submitted for New motor claim:\nPolicy ID: MOTOR-1001\nIncident type: collision',
    });
    expect(
      await sessions.answer({
        chatId: '123',
        replyToMessageId: 11,
        userId: 'u1',
        text: 'collision',
        sendPrompt: vi.fn(),
      }),
    ).toEqual({ handled: false });
  });

  it('asks again for required answers and clears an interrupted intake', async () => {
    const sessions = new TelegramRichFormSessions();
    await sessions.start({
      request,
      chatId: '123',
      sendPrompt: async () => 10,
    });
    expect(
      await sessions.answer({
        chatId: '123',
        replyToMessageId: 10,
        userId: 'u1',
        text: ' ',
        sendPrompt: async () => 12,
      }),
    ).toEqual({ handled: true });
    sessions.clearChat('123');
    expect(
      await sessions.answer({
        chatId: '123',
        replyToMessageId: 12,
        userId: 'u1',
        text: 'MOTOR-1001',
        sendPrompt: vi.fn(),
      }),
    ).toEqual({ handled: false });
  });
});
