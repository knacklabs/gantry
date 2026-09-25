import type {
  MessageSendOptions,
  RichInteractionRequest,
} from '../../domain/types.js';
import { richArrayItems } from '../rich-interaction.js';

const FORM_TTL_MS = 30 * 60 * 1000;

type FormField = { label: string; required: boolean };
type PendingForm = {
  title: string;
  fields: FormField[];
  answers: string[];
  promptMessageId: number;
  ownerId?: string;
  expiresAt: number;
};

export class TelegramRichFormSessions {
  private readonly pending = new Map<string, PendingForm>();

  clear(): void {
    this.pending.clear();
  }

  clearChat(chatId: string): void {
    this.pending.delete(chatId);
  }

  shouldSuppress(
    chatId: string,
    text: string,
    options: MessageSendOptions,
  ): boolean {
    const session = this.pending.get(chatId);
    if (!session || session.expiresAt < Date.now()) return false;
    if (
      options.files?.length ||
      options.actionAffordances?.length ||
      options.replaceMessageId ||
      options.deleteMessageId ||
      options.permissionCardView
    ) {
      return false;
    }
    const normalized = text.toLowerCase();
    const asksForInput = /\b(provide|enter|reply|complete|required)\b/.test(
      normalized,
    );
    return (
      asksForInput &&
      session.fields.some((field) =>
        normalized.includes(field.label.toLowerCase()),
      )
    );
  }

  async start(input: {
    request: RichInteractionRequest;
    chatId: string;
    sendPrompt: (text: string, placeholder: string) => Promise<number>;
  }): Promise<boolean> {
    const fields = richArrayItems(input.request.descriptor.rich?.payload.fields)
      .slice(0, 10)
      .map((field) => ({
        label: String(field.label || field.id || 'Answer'),
        required: field.required === true,
      }));
    if (!fields.length) return false;
    const title = input.request.descriptor.title;
    const promptMessageId = await input.sendPrompt(
      promptText(fields, 0),
      fields[0]!.label.slice(0, 64),
    );
    this.pending.set(input.chatId, {
      title,
      fields,
      answers: [],
      promptMessageId,
      expiresAt: Date.now() + FORM_TTL_MS,
    });
    return true;
  }

  async answer(input: {
    chatId: string;
    replyToMessageId?: number;
    userId: string;
    text: string;
    sendPrompt: (text: string, placeholder: string) => Promise<number>;
  }): Promise<{ handled: boolean; submission?: string }> {
    const session = this.pending.get(input.chatId);
    if (
      !session ||
      (input.replyToMessageId !== undefined &&
        session.promptMessageId !== input.replyToMessageId)
    )
      return { handled: false };
    if (session.expiresAt < Date.now()) {
      this.pending.delete(input.chatId);
      return { handled: false };
    }
    if (session.ownerId && session.ownerId !== input.userId)
      return { handled: false };
    const fieldIndex = session.answers.length;
    const field = session.fields[fieldIndex]!;
    const value = input.text.trim();
    if (!value && field.required) {
      session.promptMessageId = await input.sendPrompt(
        `I still need this information. ${promptText(session.fields, fieldIndex)}`,
        field.label.slice(0, 64),
      );
      return { handled: true };
    }
    session.ownerId = input.userId;
    const remainingFields = session.fields.slice(fieldIndex);
    const values = replyValues(value, remainingFields);
    session.answers.push(...values);
    session.expiresAt = Date.now() + FORM_TTL_MS;
    if (session.answers.length < session.fields.length) {
      const next = session.answers.length;
      session.promptMessageId = await input.sendPrompt(
        promptText(session.fields, next),
        session.fields[next]!.label.slice(0, 64),
      );
      return { handled: true };
    }
    this.pending.delete(input.chatId);
    const answers = session.fields
      .map((item, index) =>
        session.answers[index]
          ? `${item.label}: ${session.answers[index]}`
          : null,
      )
      .filter((answer): answer is string => Boolean(answer));
    return {
      handled: true,
      submission: `Form submitted for ${session.title}:\n${answers.join('\n')}`,
    };
  }
}

function replyValues(value: string, remainingFields: FormField[]): string[] {
  if (remainingFields.length <= 1) return [value];
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) return [value];
  if (lines.length <= remainingFields.length) return lines;
  return [
    ...lines.slice(0, remainingFields.length - 1),
    lines.slice(remainingFields.length - 1).join('\n'),
  ];
}

function promptText(fields: FormField[], index: number): string {
  const label = fields[index]!.label.trim().toLowerCase();
  if (label === 'policy id') return 'What is your policy ID?';
  if (label === 'incident type') return 'What type of incident happened?';
  if (label === 'incident date') return 'When did the incident happen?';
  if (label === 'city or location') return 'Where did the incident happen?';
  if (label === 'short description of what happened') {
    return 'Please briefly describe what happened.';
  }
  return `Please provide ${fields[index]!.label}.`;
}
