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

const SLACK_SNIPPET_MAX_BYTES = 1024 * 1024;

export type SlackSnippetFallbackInput = {
  channelId: string;
  text: string;
  threadId?: string;
  reason: string;
};

export type SlackSnippetFallbackResult = {
  fallbackArtifactId: string;
  externalMessageId?: string;
};

export function isSlackPayloadTooLarge(err: unknown): boolean {
  const candidate = err as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    error?: unknown;
    data?: { error?: unknown };
    message?: unknown;
  };
  if (
    candidate.status === 413 ||
    candidate.statusCode === 413 ||
    candidate.code === 413
  ) {
    return true;
  }
  const text = [
    candidate.error,
    candidate.data?.error,
    candidate.message,
  ].filter((value): value is string => typeof value === 'string');
  return text.some((value) => /msg_too_long|too_long|payload/i.test(value));
}

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

export async function uploadSlackTextFallback(input: {
  app: App;
  channelId: string;
  threadTs?: string;
  text: string;
}): Promise<{ fileId: string; externalMessageId?: string }> {
  const content = Buffer.from(input.text, 'utf8');
  const asSnippet = content.byteLength <= SLACK_SNIPPET_MAX_BYTES;
  const upload = await input.app.client.files.getUploadURLExternal({
    filename: 'gantry-response.txt',
    length: content.byteLength,
    ...(asSnippet ? { snippet_type: 'text' } : {}),
  });
  if (upload.ok === false || !upload.upload_url || !upload.file_id) {
    throw new Error(upload.error || 'Slack upload URL request failed');
  }
  const response = await fetch(upload.upload_url, {
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: content,
  });
  if (!response.ok) {
    throw new Error(`Slack external upload failed (${response.status})`);
  }
  const completed = (await input.app.client.files.completeUploadExternal({
    files: [{ id: upload.file_id, title: 'Gantry response' }],
    channel_id: input.channelId,
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
  })) as {
    ok?: boolean;
    error?: string;
    files?: Array<{
      shares?: Record<string, Record<string, Array<{ ts?: string }>>>;
    }>;
  };
  if (completed.ok === false) {
    throw new Error(completed.error || 'Slack upload completion failed');
  }
  const shares = completed.files?.[0]?.shares;
  const externalMessageId = shares
    ? Object.values(shares).flatMap((byChannel) =>
        Object.values(byChannel).flat(),
      )[0]?.ts
    : undefined;
  return {
    fileId: upload.file_id,
    ...(externalMessageId ? { externalMessageId } : {}),
  };
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
