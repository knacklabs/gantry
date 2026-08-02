import { ATTACHMENT_UNREACHABLE_COPY } from '../application/attachments/attachment-resolver.js';
import { logger } from '../infrastructure/logging/logger.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import type { TaskHandler } from './ipc-types.js';

const attachmentOpenHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolderJids } = context;
  const { acceptData, reject } = createTaskResponder(
    context.sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  if (!data.appId || !data.providerAccountId) {
    reject(
      'Attachment open requires signed app and provider scope.',
      'forbidden',
    );
    return;
  }
  if (
    !data.chatJid ||
    data.targetJid !== data.chatJid ||
    !sourceAgentFolderJids.includes(data.chatJid)
  ) {
    reject(
      'Attachment open must use the originating conversation.',
      'forbidden',
    );
    return;
  }
  const attachmentId = toTrimmedString(data.payload?.attachmentId, {
    maxLen: 512,
  });
  if (!attachmentId) {
    reject('Attachment id is required.', 'invalid_request');
    return;
  }
  if (!context.deps.openAttachment) {
    reject('Attachment resolver is not ready.', 'preflight_failed');
    return;
  }
  let result: Awaited<
    ReturnType<NonNullable<typeof context.deps.openAttachment>>
  >;
  try {
    result = await context.deps.openAttachment({
      attachmentId,
      appId: data.appId,
      providerAccountId: data.providerAccountId,
      conversationJid: data.chatJid,
      ...(data.authThreadId ? { threadId: data.authThreadId } : {}),
    });
  } catch (error) {
    logger.warn(
      { error, attachmentId, sourceAgentFolder: context.sourceAgentFolder },
      'Attachment open failed',
    );
    acceptData('Attachment unavailable.', {
      content: ATTACHMENT_UNREACHABLE_COPY,
    });
    return;
  }
  acceptData('Attachment opened.', { content: result.content });
};

export const attachmentOpenTaskHandlers: Record<string, TaskHandler> = {
  attachment_open: attachmentOpenHandler,
};
