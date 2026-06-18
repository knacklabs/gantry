import { logger } from '../../infrastructure/logging/logger.js';

type TelegramMediaQueue = {
  enqueue(task: () => Promise<void>): boolean;
  enqueueWhenAvailable(task: () => Promise<void>): Promise<boolean>;
  size(): number;
};

export function registerTelegramMediaHandlers(input: {
  bot: any;
  opts: {
    onChatMetadata: (
      jid: string,
      timestamp: string,
      name: string | undefined,
      provider: 'telegram',
      isGroup: boolean,
    ) => Promise<void>;
    onMessage: (jid: string, message: any) => Promise<void>;
    ensureMessageRoute?: (jid: string, message: any) => Promise<unknown>;
    conversationRoutes: () => Record<string, { folder: string }>;
  };
  mediaIngestionQueue: TelegramMediaQueue;
  downloadFile: (
    fileId: string,
    folder: string,
    filename: string,
  ) => Promise<{ storageRef: string } | null>;
  sanitizeErrorMessage: (err: unknown) => unknown;
}): void {
  const storeMedia = async (
    ctx: any,
    placeholder: string,
    opts?: { fileId?: string; filename?: string },
  ) => {
    const chatJid = `tg:${ctx.chat.id}`;
    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    await input.opts.onChatMetadata(
      chatJid,
      timestamp,
      undefined,
      'telegram',
      isGroup,
    );

    const routeGroups = input.opts.conversationRoutes;
    let groups = routeGroups();
    if (!isGroup && !groups[chatJid]) {
      await input.opts.ensureMessageRoute?.(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        provider: 'telegram',
        sender: ctx.from?.id?.toString() || '',
        sender_name:
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id?.toString() ||
          'Unknown',
        content: placeholder,
        timestamp,
        is_from_me: false,
        external_message_id: ctx.message.message_id.toString(),
        thread_id: ctx.message.message_thread_id
          ? ctx.message.message_thread_id.toString()
          : undefined,
      });
      groups = routeGroups();
    }

    const group = groups[chatJid];
    if (!group && isGroup) return;

    const senderName =
      ctx.from?.first_name ||
      ctx.from?.username ||
      ctx.from?.id?.toString() ||
      'Unknown';
    const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

    const deliver = async (
      content: string,
      attachment?: {
        kind: 'image' | 'file' | 'audio' | 'video' | 'other';
        externalId?: string;
        storageRef?: string;
      },
    ) => {
      const threadId = ctx.message.message_thread_id;
      const msgId = ctx.message.message_id.toString();
      await input.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        provider: 'telegram',
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        external_message_id: msgId,
        thread_id: threadId ? threadId.toString() : undefined,
        attachments: attachment
          ? [
              {
                id: `telegram-attachment:${chatJid}:${msgId}`,
                kind: attachment.kind,
                externalId: attachment.externalId,
                storageRef: attachment.storageRef,
              },
            ]
          : undefined,
      });
    };

    if (opts?.fileId && group) {
      const msgId = ctx.message.message_id.toString();
      const filename =
        opts.filename ||
        `${placeholder.replace(/[[\] ]/g, '').toLowerCase()}_${msgId}`;
      const downloaded = await input.downloadFile(
        opts.fileId,
        group.folder,
        filename,
      );
      const kind =
        placeholder === '[Photo]'
          ? 'image'
          : placeholder === '[Video]'
            ? 'video'
            : placeholder === '[Voice message]' || placeholder === '[Audio]'
              ? 'audio'
              : 'file';
      if (downloaded) {
        await deliver(`${placeholder} (${downloaded.storageRef})${caption}`, {
          kind,
          externalId: opts.fileId,
          storageRef: downloaded.storageRef,
        });
      } else {
        await deliver(`${placeholder}${caption}`, {
          kind,
          externalId: opts.fileId,
        });
      }
      return;
    }

    await deliver(`${placeholder}${caption}`);
  };

  const enqueueMediaStore = async (
    ctx: any,
    placeholder: string,
    opts?: { fileId?: string; filename?: string },
  ): Promise<void> => {
    const task = async () => {
      try {
        await storeMedia(ctx, placeholder, opts);
      } catch (err) {
        logger.error(
          { err: input.sanitizeErrorMessage(err) },
          'Telegram media ingestion failed',
        );
      }
    };
    const admitted = input.mediaIngestionQueue.enqueue(task);
    if (admitted) return;

    logger.warn(
      {
        chatId: ctx.chat?.id?.toString(),
        messageId: ctx.message?.message_id?.toString(),
      },
      'Telegram media ingestion queue full; waiting to enqueue media event',
    );
    const queued = await input.mediaIngestionQueue.enqueueWhenAvailable(task);
    if (!queued) {
      logger.error(
        {
          chatId: ctx.chat?.id?.toString(),
          messageId: ctx.message?.message_id?.toString(),
          queueSize: input.mediaIngestionQueue.size(),
        },
        'Telegram media ingestion backlog full; media event was not admitted',
      );
    }
  };

  input.bot.on('message:photo', async (ctx: any) => {
    const photos = ctx.message.photo;
    const largest = photos?.[photos.length - 1];
    await enqueueMediaStore(ctx, '[Photo]', {
      fileId: largest?.file_id,
      filename: `photo_${ctx.message.message_id}`,
    });
  });
  input.bot.on('message:video', async (ctx: any) => {
    await enqueueMediaStore(ctx, '[Video]', {
      fileId: ctx.message.video?.file_id,
      filename: `video_${ctx.message.message_id}`,
    });
  });
  input.bot.on('message:voice', async (ctx: any) => {
    await enqueueMediaStore(ctx, '[Voice message]', {
      fileId: ctx.message.voice?.file_id,
      filename: `voice_${ctx.message.message_id}`,
    });
  });
  input.bot.on('message:audio', async (ctx: any) => {
    const name =
      ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
    await enqueueMediaStore(ctx, '[Audio]', {
      fileId: ctx.message.audio?.file_id,
      filename: name,
    });
  });
  input.bot.on('message:document', async (ctx: any) => {
    const name = ctx.message.document?.file_name || 'file';
    await enqueueMediaStore(ctx, `[Document: ${name}]`, {
      fileId: ctx.message.document?.file_id,
      filename: name,
    });
  });
  input.bot.on('message:sticker', async (ctx: any) => {
    const emoji = ctx.message.sticker?.emoji || '';
    await enqueueMediaStore(ctx, `[Sticker ${emoji}]`);
  });
  input.bot.on('message:location', async (ctx: any) => {
    await enqueueMediaStore(ctx, '[Location]');
  });
  input.bot.on('message:contact', async (ctx: any) => {
    await enqueueMediaStore(ctx, '[Contact]');
  });
}
