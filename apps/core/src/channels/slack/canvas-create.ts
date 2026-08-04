// Channel-canvas creation flow, extracted from canvas.ts (size budget).
import {
  type ContentCanvasAction,
  type ContentCanvasResult,
} from '../../shared/content-canvas.js';
import {
  asRecord,
  boundCanvasIdFromConversationInfo,
  optionalString,
  remainingTimeoutMs,
  requiredString,
  SlackCanvasProviderError,
} from './canvas-support.js';

const SLACK_CANVAS_READ_DEADLINE_MS = 100_000;

export interface CanvasCreateCtx {
  slackApi(
    method: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  fileInfo(
    canvasId: string,
    requiredForRead: boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  mintReadWriteHandles(
    conversationJid: string,
    canvasId: string,
  ): Pick<ContentCanvasResult, 'canvasReadHandle' | 'canvasUpdateHandle'>;
}

export async function createChannelCanvas(
  ctx: CanvasCreateCtx,
  channelId: string,
  conversationJid: string,
  input: Extract<ContentCanvasAction, { action: 'create' }>,
): Promise<ContentCanvasResult> {
  // One creation deadline shared by create + existing-canvas resolution +
  // permalink lookup, under the caller's 120s timeout.
  const deadlineAt = Date.now() + SLACK_CANVAS_READ_DEADLINE_MS;
  let canvasId: string;
  let existing = false;
  try {
    const response = await ctx.slackApi(
      'conversations.canvases.create',
      {
        channel_id: channelId,
        ...(input.title ? { title: input.title } : {}),
        ...(input.markdown !== undefined
          ? {
              document_content: {
                type: 'markdown',
                markdown: input.markdown,
              },
            }
          : {}),
      },
      remainingTimeoutMs(deadlineAt),
    );
    canvasId = requiredString(response.canvas_id, 'canvas_id');
  } catch (error) {
    if (
      !(error instanceof SlackCanvasProviderError) ||
      (error.code !== 'free_team_canvas_tab_already_exists' &&
        error.code !== 'channel_canvas_already_exists')
    ) {
      throw error;
    }
    existing = true;
    canvasId = await resolveBoundCanvasId(ctx, channelId, deadlineAt);
  }

  const handles = ctx.mintReadWriteHandles(conversationJid, canvasId);
  const permalink = await lookupPermalink(ctx, canvasId, deadlineAt);
  return {
    message: existing
      ? 'This channel already has a canvas; creation was unnecessary and the existing bound canvas is ready.'
      : permalink
        ? 'Canvas created in this Slack conversation.'
        : 'Canvas created in this Slack conversation, but Slack did not return its permalink. The canvas handles are still usable.',
    ...handles,
    ...(permalink ? { permalink } : {}),
  };
}

async function resolveBoundCanvasId(
  ctx: CanvasCreateCtx,
  channelId: string,
  deadlineAt: number,
): Promise<string> {
  const response = await ctx.slackApi(
    'conversations.info',
    { channel: channelId },
    remainingTimeoutMs(deadlineAt),
  );
  const fileId = boundCanvasIdFromConversationInfo(response);
  if (!fileId) {
    throw new Error(
      'This channel already has a canvas, but Slack did not identify it. Open the existing canvas in Slack and try again after reinstalling the app scopes if needed.',
    );
  }
  return fileId;
}

async function lookupPermalink(
  ctx: CanvasCreateCtx,
  canvasId: string,
  deadlineAt: number,
): Promise<string | undefined> {
  try {
    const response = await ctx.fileInfo(
      canvasId,
      false,
      remainingTimeoutMs(deadlineAt),
    );
    return optionalString(asRecord(response.file)?.permalink);
  } catch {
    return undefined;
  }
}
