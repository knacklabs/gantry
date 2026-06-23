import { InputFile } from 'grammy';

import type {
  MessageFileAttachment,
  MessageSendOptions,
} from '../../domain/types.js';
import { telegramThreadOptionsFromString } from './channel-shared.js';

const TELEGRAM_FILE_MAX_BYTES = 50 * 1024 * 1024;
type TelegramFileApi = {
  sendDocument: (...args: any[]) => Promise<{ message_id?: number }>;
  sendMessage: (...args: any[]) => Promise<{ message_id?: number }>;
};

export async function sendTelegramDocuments(input: {
  api: TelegramFileApi;
  chatId: string;
  threadId?: string;
  files?: MessageFileAttachment[];
}): Promise<string[]> {
  const sent: string[] = [];
  for (const file of input.files ?? []) {
    if (file.sizeBytes > TELEGRAM_FILE_MAX_BYTES) {
      const id = await sendTelegramAttachmentUnavailable(
        input,
        `${file.filename} exceeds 50 MB.`,
      );
      if (id) sent.push(id);
      continue;
    }
    try {
      const result = await input.api.sendDocument(
        input.chatId,
        new InputFile(file.content, file.filename),
        {
          ...telegramThreadOptionsFromString(input.threadId),
          caption: file.filename,
        },
      );
      if (result.message_id !== undefined) sent.push(String(result.message_id));
    } catch {
      // ponytail: text already went out; skip failed attachment instead of duplicating the message on retry.
      const id = await sendTelegramAttachmentUnavailable(
        input,
        `${file.filename} upload failed.`,
      );
      if (id) sent.push(id);
    }
  }
  return sent;
}

export async function appendTelegramDocumentMessageIds(
  externalMessageIds: string[],
  api: TelegramFileApi,
  chatId: string,
  options: Pick<MessageSendOptions, 'threadId' | 'files'>,
): Promise<void> {
  externalMessageIds.push(
    ...(await sendTelegramDocuments({
      api,
      chatId,
      threadId: options.threadId,
      files: options.files,
    })),
  );
}

async function sendTelegramAttachmentUnavailable(
  input: {
    api: { sendMessage: (...args: any[]) => Promise<{ message_id?: number }> };
    chatId: string;
    threadId?: string;
  },
  reason: string,
): Promise<string | undefined> {
  try {
    const result = await input.api.sendMessage(
      input.chatId,
      `Attachment unavailable in Telegram: ${reason}`,
      telegramThreadOptionsFromString(input.threadId),
    );
    return result.message_id === undefined
      ? undefined
      : String(result.message_id);
  } catch {
    return undefined;
  }
}
