import { logger } from '../../infrastructure/logging/logger.js';
import { writeInboundAttachment } from '../../shared/inbound-attachment-writer.js';

export const SLACK_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export async function writeSlackAttachmentResponse(
  response: Response,
  workspaceRoot: string,
  workspaceRelativePath: string,
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
    await writeInboundAttachment({
      workspaceRoot,
      workspaceRelativePath,
      content: buffer,
      maxBytes: SLACK_MAX_ATTACHMENT_BYTES,
    });
    return true;
  }

  let result;
  try {
    result = await writeInboundAttachment({
      workspaceRoot,
      workspaceRelativePath,
      content: reader,
      maxBytes: SLACK_MAX_ATTACHMENT_BYTES,
    });
  } catch (err) {
    throw new Error('Failed to stream Slack attachment', { cause: err });
  }
  if (result.status === 'too-large') {
    logger.warn(
      { bytes: result.bytes, maxBytes: SLACK_MAX_ATTACHMENT_BYTES },
      'Slack file exceeds max allowed size',
    );
    return false;
  }
  return true;
}
