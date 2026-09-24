import type { RichInteractionRequest } from '../../domain/types.js';
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
      promptText(title, fields, 0),
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
    replyToMessageId: number;
    userId: string;
    text: string;
    sendPrompt: (text: string, placeholder: string) => Promise<number>;
  }): Promise<{ handled: boolean; submission?: string }> {
    const session = this.pending.get(input.chatId);
    if (!session || session.promptMessageId !== input.replyToMessageId)
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
        `${field.label} is required. ${promptText(session.title, session.fields, fieldIndex)}`,
        field.label.slice(0, 64),
      );
      return { handled: true };
    }
    session.ownerId = input.userId;
    session.answers.push(value);
    session.expiresAt = Date.now() + FORM_TTL_MS;
    if (session.answers.length < session.fields.length) {
      const next = session.answers.length;
      session.promptMessageId = await input.sendPrompt(
        promptText(session.title, session.fields, next),
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

function promptText(title: string, fields: FormField[], index: number): string {
  return `${title} (${index + 1}/${fields.length})\n${fields[index]!.label}${fields[index]!.required ? ' (required)' : ' (optional)'}\nReply to this message with your answer.`;
}
