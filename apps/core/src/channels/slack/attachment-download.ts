import fs from 'fs';

import { logger } from '../../infrastructure/logging/logger.js';
import {
  PRIVATE_FILE_MODE,
  assertPrivateFileTargetSync,
  writePrivateFileSync,
} from '../../shared/private-fs.js';

export const SLACK_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export async function writeSlackAttachmentResponse(
  response: Response,
  destPath: string,
): Promise<boolean> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > SLACK_MAX_ATTACHMENT_BYTES
  ) {
    logger.warn(
      { declaredLength, maxBytes: SLACK_MAX_ATTACHMENT_BYTES },
      'Slack file exceeds max allowed size',
    );
    return false;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > SLACK_MAX_ATTACHMENT_BYTES) {
      logger.warn(
        { bytes: buffer.byteLength, maxBytes: SLACK_MAX_ATTACHMENT_BYTES },
        'Slack file exceeds max allowed size',
      );
      return false;
    }
    writePrivateFileSync(destPath, buffer);
    return true;
  }

  assertPrivateFileTargetSync(destPath);
  const fd = fs.openSync(destPath, 'w', PRIVATE_FILE_MODE);
  let totalBytes = 0;
  let shouldCleanup = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (!value || value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > SLACK_MAX_ATTACHMENT_BYTES) {
        shouldCleanup = true;
        logger.warn(
          { bytes: totalBytes, maxBytes: SLACK_MAX_ATTACHMENT_BYTES },
          'Slack file exceeds max allowed size',
        );
        return false;
      }
      fs.writeSync(fd, Buffer.from(value));
    }
    return true;
  } catch (err) {
    shouldCleanup = true;
    throw new Error('Failed to stream Slack attachment', { cause: err });
  } finally {
    fs.closeSync(fd);
    if (shouldCleanup) {
      try {
        fs.unlinkSync(destPath);
      } catch {
        // ignore cleanup failures
      }
    } else {
      fs.chmodSync(destPath, PRIVATE_FILE_MODE);
    }
  }
}
