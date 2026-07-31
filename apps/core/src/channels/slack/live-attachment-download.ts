import path from 'node:path';

import { logger } from '../../infrastructure/logging/logger.js';
import { createInboundAttachmentStorageRef } from '../../shared/inbound-attachment-writer.js';
import { ensurePrivateDirSync } from '../../shared/private-fs.js';
import { findConversationRoutesForChat } from '../../shared/thread-queue-key.js';
import type { ChannelOpts } from '../channel-provider.js';
import { writeSlackAttachmentResponse } from './attachment-download.js';
import { classifySlackDownloadResponse } from './historical-attachment-fetcher.js';

export type SlackAttachmentDownload =
  | { status: 'ok'; filePath: string; storageRef: string }
  | { status: 'deleted' }
  | { status: 'unreachable' };

export async function downloadSlackAttachment(input: {
  jid: string;
  file: {
    name?: string;
    title?: string;
    url_private?: string;
    url_private_download?: string;
  };
  threadId?: string;
  targetFolder?: string;
  conversationRoutes: ChannelOpts['conversationRoutes'];
  providerAccountId?: string;
  botToken: string;
  sanitizeFilename: (raw: string) => string;
  resolveWorkspaceFolder: (folder: string) => string;
}): Promise<SlackAttachmentDownload> {
  const url = input.file.url_private_download || input.file.url_private;
  if (!url) return { status: 'unreachable' };
  const groups = input.targetFolder
    ? []
    : findConversationRoutesForChat(
        input.conversationRoutes(),
        input.jid,
        input.threadId,
        input.providerAccountId,
      );
  if (!input.targetFolder && groups.length < 1) {
    return { status: 'unreachable' };
  }
  const filename = input.sanitizeFilename(
    input.file.name || input.file.title || 'attachment.bin',
  );
  const storageRef = createInboundAttachmentStorageRef(filename);
  const folders = input.targetFolder
    ? [input.targetFolder]
    : Array.from(new Set(groups.map(([, group]) => group.folder)));
  if (folders.length !== 1) return { status: 'unreachable' };

  try {
    const groupDir = input.resolveWorkspaceFolder(folders[0]);
    ensurePrivateDirSync(path.join(groupDir, 'attachments'));
    const destPath = path.join(groupDir, ...storageRef.split('/'));
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${input.botToken}`,
      },
    });
    const failure = await classifySlackDownloadResponse(response);
    if (failure) {
      logger.warn(
        { jid: input.jid, status: response.status, filename },
        'Failed to download Slack attachment',
      );
      return failure.status === 'deleted'
        ? { status: 'deleted' }
        : { status: 'unreachable' };
    }

    const wrote = await writeSlackAttachmentResponse(
      response,
      groupDir,
      storageRef,
    );
    if (!wrote) return { status: 'unreachable' };
    return { status: 'ok', filePath: destPath, storageRef };
  } catch (error) {
    if (isFileExistsError(error)) throw error;
    logger.warn(
      { jid: input.jid, error, filename },
      'Slack attachment download failed',
    );
    return { status: 'unreachable' };
  }
}

function isFileExistsError(error: unknown): boolean {
  let current = error;
  while (typeof current === 'object' && current !== null) {
    if ('code' in current && current.code === 'EEXIST') return true;
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}
