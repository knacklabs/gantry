import {
  createInboundAttachmentStorageRef,
  writeInboundAttachment,
  type InboundAttachmentReader,
} from '../shared/inbound-attachment-writer.js';
import { logger } from '../infrastructure/logging/logger.js';

export const TELEGRAM_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export interface TelegramDownloadResponse {
  body?: {
    getReader?: () => {
      read: () => Promise<{ done: boolean; value?: Uint8Array }>;
    };
  } | null;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  headers?: { get: (name: string) => string | null };
}

export async function writeTelegramFetchResponseToFile(
  response: TelegramDownloadResponse,
  workspaceRoot: string,
  filename: string,
): Promise<string | null> {
  const declaredLength = Number(response.headers?.get('content-length'));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > TELEGRAM_MAX_DOWNLOAD_BYTES
  ) {
    logger.warn(
      {
        declaredLength,
        maxBytes: TELEGRAM_MAX_DOWNLOAD_BYTES,
      },
      'Telegram file exceeds max allowed size',
    );
    return null;
  }

  const storageRef = createInboundAttachmentStorageRef(filename);
  const reader = response.body?.getReader?.();
  if (!reader) {
    if (!response.arrayBuffer) {
      throw new Error('Telegram download response body is missing');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > TELEGRAM_MAX_DOWNLOAD_BYTES) {
      logger.warn(
        {
          bytes: buffer.byteLength,
          maxBytes: TELEGRAM_MAX_DOWNLOAD_BYTES,
        },
        'Telegram file exceeds max allowed size',
      );
      return null;
    }
    await writeInboundAttachment({
      workspaceRoot,
      workspaceRelativePath: storageRef,
      content: buffer,
      maxBytes: TELEGRAM_MAX_DOWNLOAD_BYTES,
    });
    return storageRef;
  }

  const result = await writeInboundAttachment({
    workspaceRoot,
    workspaceRelativePath: storageRef,
    content: reader as InboundAttachmentReader,
    maxBytes: TELEGRAM_MAX_DOWNLOAD_BYTES,
  });
  if (result.status === 'too-large') {
    logger.warn(
      {
        bytes: result.bytes,
        maxBytes: TELEGRAM_MAX_DOWNLOAD_BYTES,
      },
      'Telegram file exceeds max allowed size',
    );
    return null;
  }
  return storageRef;
}
