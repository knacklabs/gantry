import type { App } from '@slack/bolt';

import { logger } from '../../infrastructure/logging/logger.js';
import {
  uploadSlackTextFallback,
  type SlackSnippetFallbackInput,
  type SlackSnippetFallbackResult,
} from './file-delivery.js';

export async function sendSlackSnippetFallback(
  input: SlackSnippetFallbackInput & { app: App | null },
): Promise<SlackSnippetFallbackResult | null> {
  if (!input.app) return null;
  try {
    const uploaded = await uploadSlackTextFallback({
      app: input.app,
      channelId: input.channelId,
      text: input.text,
      threadTs: input.threadId,
    });
    return {
      fallbackArtifactId: uploaded.fileId,
      ...(uploaded.externalMessageId
        ? { externalMessageId: uploaded.externalMessageId }
        : {}),
    };
  } catch (error) {
    logger.warn(
      { channelId: input.channelId, reason: input.reason, error },
      'Slack snippet fallback upload failed; using split text delivery',
    );
    return null;
  }
}
