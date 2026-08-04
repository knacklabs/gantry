import type { App } from '@slack/bolt';

import type { MessageFileAttachment } from '../../domain/types.js';

type SlackPostMessagePayload = {
  channel: string;
  text: string;
  thread_ts?: string;
};

type SlackDeliveryLogger = {
  warn(metadata: Record<string, unknown>, message: string): void;
};

type PostSlackMessageWithRetry = (
  app: App | null,
  payload: SlackPostMessagePayload,
  context: { jid: string; part: number; totalParts: number },
  warnings: string[],
  log: SlackDeliveryLogger,
) => Promise<{ ts?: string }>;

async function uploadSlackAttachment(input: {
  app: App;
  channelId: string;
  threadTs?: string;
  file: MessageFileAttachment;
}): Promise<void> {
  const upload = await input.app.client.files.getUploadURLExternal({
    filename: input.file.filename,
    length: input.file.sizeBytes,
  });
  if (upload.ok === false || !upload.upload_url || !upload.file_id) {
    throw new Error(upload.error || 'Slack upload URL request failed');
  }
  const response = await fetch(upload.upload_url, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from(input.file.content),
  });
  if (!response.ok) {
    throw new Error(`Slack external upload failed (${response.status})`);
  }
  const completed = await input.app.client.files.completeUploadExternal({
    files: [{ id: upload.file_id, title: input.file.filename }],
    channel_id: input.channelId,
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
  });
  if (completed.ok === false) {
    throw new Error(completed.error || 'Slack upload completion failed');
  }
}

export async function uploadSlackAttachments(input: {
  app: App;
  jid: string;
  channelId: string;
  threadTs?: string;
  files?: MessageFileAttachment[];
  warnings: string[];
  externalMessageIds: string[];
  log: SlackDeliveryLogger;
  postSlackMessageWithRetry: PostSlackMessageWithRetry;
}): Promise<void> {
  for (const [index, file] of (input.files ?? []).entries()) {
    try {
      await uploadSlackAttachment({
        app: input.app,
        channelId: input.channelId,
        threadTs: input.threadTs,
        file,
      });
    } catch (error) {
      const reason = `${file.filename} upload failed.`;
      input.warnings.push('slack.attachment_upload_failed');
      input.log.warn(
        { jid: input.jid, path: file.filename, reason, error },
        'Slack attachment upload failed',
      );
      try {
        const posted = await input.postSlackMessageWithRetry(
          input.app,
          {
            channel: input.channelId,
            text: `Attachment unavailable in Slack: ${reason}`,
            ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
          },
          {
            jid: input.jid,
            part: index + 1,
            totalParts: input.files?.length ?? 0,
          },
          input.warnings,
          input.log,
        );
        if (posted.ts) input.externalMessageIds.push(posted.ts);
      } catch (fallbackError) {
        input.log.warn(
          { jid: input.jid, path: file.filename, reason, error: fallbackError },
          'Slack attachment fallback message failed',
        );
        throw fallbackError;
      }
    }
  }
}
