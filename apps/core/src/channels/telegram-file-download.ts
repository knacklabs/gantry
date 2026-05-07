import fs from 'fs';

import { PRIVATE_FILE_MODE } from '../shared/private-fs.js';
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
  destPath: string,
): Promise<boolean> {
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
    return false;
  }

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
      return false;
    }
    await fs.promises.writeFile(destPath, buffer, { mode: PRIVATE_FILE_MODE });
    return true;
  }

  const file = await fs.promises.open(destPath, 'w', PRIVATE_FILE_MODE);
  let totalBytes = 0;
  let shouldCleanup = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (!value || value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > TELEGRAM_MAX_DOWNLOAD_BYTES) {
        shouldCleanup = true;
        logger.warn(
          {
            bytes: totalBytes,
            maxBytes: TELEGRAM_MAX_DOWNLOAD_BYTES,
          },
          'Telegram file exceeds max allowed size',
        );
        return false;
      }
      await file.write(Buffer.from(value));
    }
    return true;
  } catch (err) {
    shouldCleanup = true;
    throw err;
  } finally {
    await file.close();
    if (shouldCleanup) {
      try {
        await fs.promises.unlink(destPath);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
