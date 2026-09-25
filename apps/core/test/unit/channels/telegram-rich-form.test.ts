import { describe, expect, it, vi } from 'vitest';
import { TelegramRichFormSessions } from '@core/channels/telegram/rich-form-session.js';
import { renderTelegramRichInteraction } from '@core/channels/telegram/rich-interaction.js';
import {
  handleTelegramTextMessage,
  normalizeTelegramPrivateCommand,
} from '@core/channels/telegram/text-message-handler.js';
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

const fullRequest: RichInteractionRequest = {
  ...request,
  descriptor: {
    ...request.descriptor,
    rich: {
      ...request.descriptor.rich!,
      payload: {
        fields: [
          { id: 'policy', label: 'Policy ID', required: true },
          { id: 'incident', label: 'Incident type', required: true },
          { id: 'date', label: 'Incident date', required: true },
          { id: 'city', label: 'City or location', required: true },
          {
            id: 'description',
            label: 'Short description of what happened',
            required: true,
          },
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
      'What is your policy ID?',
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
          expect(text).toBe('What type of incident happened?');
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

  it('asks natural questions without progress counters', async () => {
    const sessions = new TelegramRichFormSessions();
    const prompts: string[] = [];
    await sessions.start({
      request: fullRequest,
      chatId: '123',
      sendPrompt: async (text) => {
        prompts.push(text);
        return 10;
      },
    });
    const answers = ['MOTOR-1001', 'Collision', '22 September', 'Hyderabad'];
    for (const [index, answer] of answers.entries()) {
      await sessions.answer({
        chatId: '123',
        replyToMessageId: 10 + index,
        userId: 'u1',
        text: answer,
        sendPrompt: async (text) => {
          prompts.push(text);
          return 11 + index;
        },
      });
    }

    expect(prompts).toEqual([
      'What is your policy ID?',
      'What type of incident happened?',
      'When did the incident happen?',
      'Where did the incident happen?',
      'Please briefly describe what happened.',
    ]);
    expect(prompts.join('\n')).not.toMatch(/\(\d+\/\d+\)/);
  });

  it('accepts normal private-chat messages without reply metadata', async () => {
    const sessions = new TelegramRichFormSessions();
    const prompts: string[] = [];
    await sessions.start({
      request: fullRequest,
      chatId: '123',
      sendPrompt: async (text) => {
        prompts.push(text);
        return 10;
      },
    });

    expect(
      await sessions.answer({
        chatId: '123',
        userId: 'u1',
        text: 'MOTOR-1001',
        sendPrompt: async (text) => {
          prompts.push(text);
          return 11;
        },
      }),
    ).toEqual({ handled: true });
    expect(prompts).toEqual([
      'What is your policy ID?',
      'What type of incident happened?',
    ]);
  });

  it('routes an unthreaded private message into the active form', async () => {
    const tryResolveForm = vi
      .fn()
      .mockResolvedValue({ handled: true } as const);
    await handleTelegramTextMessage({
      ctx: {
        message: {
          message_id: 516,
          date: 1_790_319_607,
          text: 'MOTOR-1001',
        },
        chat: { id: 1355991233, type: 'private' },
        from: { id: 123, first_name: 'Pulkit' },
        me: { username: 'motobuddy' },
      } as never,
      opts: {} as never,
      assistantName: 'MotoBuddy',
      triggerPattern: /@MotoBuddy\b/i,
      tryResolveForm,
      tryResolveOther: vi.fn().mockResolvedValue(false),
    });

    expect(tryResolveForm).toHaveBeenCalledWith({
      chatId: '1355991233',
      userId: '123',
      text: 'MOTOR-1001',
    });
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

  it('accepts the remaining form answers in one multiline reply', async () => {
    const sessions = new TelegramRichFormSessions();
    await sessions.start({
      request: fullRequest,
      chatId: '123',
      sendPrompt: async () => 10,
    });

    expect(
      await sessions.answer({
        chatId: '123',
        replyToMessageId: 10,
        userId: 'u1',
        text: [
          'MOTOR-1001',
          'Car Crash',
          '22 September',
          'Hyderabad',
          'Car crashed into pillar',
        ].join('\n'),
        sendPrompt: vi.fn(),
      }),
    ).toEqual({
      handled: true,
      submission: [
        'Form submitted for New motor claim:',
        'Policy ID: MOTOR-1001',
        'Incident type: Car Crash',
        'Incident date: 22 September',
        'City or location: Hyderabad',
        'Short description of what happened: Car crashed into pillar',
      ].join('\n'),
    });
  });

  it('suppresses only redundant field requests while a form is active', async () => {
    const sessions = new TelegramRichFormSessions();
    await sessions.start({
      request,
      chatId: '123',
      sendPrompt: async () => 10,
    });

    expect(
      sessions.shouldSuppress(
        '123',
        'Please provide your Policy ID and Incident type.',
        {},
      ),
    ).toBe(true);
    expect(
      sessions.shouldSuppress(
        '123',
        'I’ll collect the incident details needed to start the claim.',
        {},
      ),
    ).toBe(false);
    expect(
      sessions.shouldSuppress('other-chat', 'Provide Policy ID.', {}),
    ).toBe(false);
  });
});
