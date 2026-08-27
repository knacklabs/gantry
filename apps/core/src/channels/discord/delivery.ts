import { discordChannelIdFromJid } from './interaction-helpers.js';
import type {
  JobNotificationView,
  MessageDeliveryResult,
  MessageFileAttachment,
} from '../../domain/types.js';
import type { AgentTodoRender } from '../../domain/ports/task-lifecycle.js';
import { PartialMessageDeliveryError } from '../../domain/messages/partial-delivery.js';
import { formatDuration } from '../../shared/human-format.js';
import {
  agentTodoLines,
  formatAgentProgressLine,
  formatAgentTodoHeader,
  hasAgentTodoCardHeader,
} from '../agent-todo-render.js';
import {
  DISCORD_FILE_MAX_BYTES,
  DISCORD_MESSAGE_MAX_LENGTH,
} from './limits.js';

const DISCORD_TODO_MAX_LENGTH = 1900;
const DISCORD_EMBED_TITLE_MAX_LENGTH = 256;
const DISCORD_EMBED_DESCRIPTION_MAX_LENGTH = 4096;
const DISCORD_EMBED_FOOTER_MAX_LENGTH = 2048;

const DISCORD_JOB_STATUS: Record<
  JobNotificationView['status'],
  { emoji: string; label: string; color: number }
> = {
  completed: { emoji: '✅', label: 'Completed', color: 0x57f287 },
  failed: { emoji: '❌', label: 'Failed', color: 0xed4245 },
  paused: { emoji: '⏸️', label: 'Paused', color: 0xfee75c },
  timeout: { emoji: '⏱️', label: 'Timed out', color: 0xed4245 },
  dead_lettered: {
    emoji: '⏸️',
    label: 'Paused after failures',
    color: 0xed4245,
  },
};

const DISCORD_JOB_OUTCOME_MARKER: Record<
  NonNullable<JobNotificationView['result']>['items'][number]['outcome'],
  string
> = {
  done: '✅',
  skipped: '⏭️',
  failed: '❌',
};

export type DiscordMessagePoster = (
  channelId: string,
  body: Record<string, unknown>,
) => Promise<{ id?: string }>;

export function splitDiscordText(text: string): string[] {
  const value = text || ' ';
  const parts: string[] = [];
  for (
    let index = 0;
    index < value.length;
    index += DISCORD_MESSAGE_MAX_LENGTH
  ) {
    parts.push(value.slice(index, index + DISCORD_MESSAGE_MAX_LENGTH));
  }
  return parts.length ? parts : [' '];
}

export function formatDiscordAgentTodo(render: AgentTodoRender): string {
  if (render.cardKind === 'progress') return formatAgentProgressLine(render);
  const title = formatAgentTodoHeader(render);
  const header = hasAgentTodoCardHeader(render) ? title : `📋 ${title}`;
  const lines: string[] = [header];
  let used = header.length + 16;
  let dropped = 0;
  const todoLines = agentTodoLines(render);
  for (let index = 0; index < todoLines.length; index += 1) {
    const line = todoLines[index];
    if (used + line.length + 1 > DISCORD_TODO_MAX_LENGTH) {
      dropped = todoLines.length - index;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (dropped > 0) lines.push(`… (${dropped} more)`);
  return lines.join('\n');
}

export function discordJobNotificationEmbed(
  view: JobNotificationView,
): Record<string, unknown> {
  const status = DISCORD_JOB_STATUS[view.status];
  const stats = view.stats
    ? [
        ...(view.durationMs === undefined
          ? []
          : [formatDuration(view.durationMs)]),
        `${view.stats.toolCount} tool${view.stats.toolCount === 1 ? '' : 's'}`,
        view.stats.browserUsed ? 'browser used' : 'browser not used',
        `last ${view.stats.lastAction ?? 'none'}`,
      ].join(' · ')
    : '';
  const body = view.result
    ? [
        ...(view.result.headline ? [view.result.headline] : []),
        ...view.result.items.map((item) =>
          [
            DISCORD_JOB_OUTCOME_MARKER[item.outcome],
            item.label,
            item.detail ? `— ${item.detail}` : '',
          ]
            .filter(Boolean)
            .join(' '),
        ),
        ...(view.result.nextAction ? [`Next: ${view.result.nextAction}`] : []),
      ]
    : [view.fallbackText];
  return {
    title: truncateDiscordEmbedText(
      `${status.emoji} ${status.label} · ${view.jobName}`,
      DISCORD_EMBED_TITLE_MAX_LENGTH,
    ),
    color: status.color,
    // The view is pre-bounded by boundJobNotificationView (total content well
    // under 2300 code units), so this description cap is defense-in-depth and
    // never actually drops content for a job notification.
    description: truncateDiscordEmbedText(
      [stats, ...body].filter(Boolean).join('\n') || ' ',
      DISCORD_EMBED_DESCRIPTION_MAX_LENGTH,
    ),
    ...(view.nextRunAt
      ? {
          footer: {
            text: truncateDiscordEmbedText(
              `Next run: ${view.nextRunAt}`,
              DISCORD_EMBED_FOOTER_MAX_LENGTH,
            ),
          },
        }
      : {}),
  };
}

function truncateDiscordEmbedText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let truncated = '';
  for (const codePoint of value) {
    if (truncated.length + codePoint.length > maxLength - 1) break;
    truncated += codePoint;
  }
  return `${truncated}…`;
}

export async function postDiscordMessageParts(input: {
  channelId: string;
  parts: string[];
  components?: unknown[];
  embeds?: unknown[];
  files?: MessageFileAttachment[];
  apiRoot?: string;
  botToken?: string;
  post: DiscordMessagePoster;
  shouldContinue?: () => boolean;
}): Promise<MessageDeliveryResult> {
  const externalMessageIds: string[] = [];
  let deliveredParts = 0;
  const oversized =
    input.files?.filter((file) => file.sizeBytes > DISCORD_FILE_MAX_BYTES) ??
    [];
  const parts = input.parts;
  for (let index = 0; index < parts.length; index += 1) {
    if (input.shouldContinue && !input.shouldContinue()) break;
    try {
      const body = {
        ...(input.embeds ? {} : { content: parts[index] }),
        allowed_mentions: { parse: [] },
        ...(index === 0 && input.embeds ? { embeds: input.embeds } : {}),
        components: index === parts.length - 1 ? input.components : undefined,
      };
      const canUploadFiles =
        index === parts.length - 1 &&
        input.files?.some((file) => file.sizeBytes <= DISCORD_FILE_MAX_BYTES) &&
        input.apiRoot &&
        input.botToken;
      const posted = canUploadFiles
        ? await postDiscordFilesOrTextFallback(input, body)
        : await input.post(input.channelId, body);
      if (posted.id) externalMessageIds.push(posted.id);
      deliveredParts += 1;
    } catch (err) {
      if (deliveredParts > 0) {
        const unsentTail = parts.slice(deliveredParts).join('');
        const partial = new PartialMessageDeliveryError({
          cause: err,
          deliveredChunks: deliveredParts,
          name: 'PartialDiscordDeliveryError',
          message: `Discord message partially delivered (${deliveredParts}/${parts.length} parts)`,
          totalChunks: parts.length,
        });
        Object.assign(partial, {
          provider: 'discord',
          deliveredParts,
          totalParts: parts.length,
          externalMessageIds,
          ...(unsentTail.trim()
            ? {
                retryTail: {
                  canonicalText: unsentTail,
                  providerPayload: {
                    provider: 'discord',
                    channelId: input.channelId,
                  },
                },
              }
            : {}),
          warnings: ['discord.partial_delivery'],
        });
        throw partial;
      }
      throw err;
    }
  }
  if (oversized.length > 0) {
    const warning = await input
      .post(input.channelId, {
        content: oversized
          .map(
            (file) =>
              `Attachment unavailable in Discord: ${file.filename} exceeds 25 MB.`,
          )
          .join('\n'),
        allowed_mentions: { parse: [] },
      })
      .catch(() => undefined);
    if (warning?.id) externalMessageIds.push(warning.id);
  }
  return {
    ...(externalMessageIds[0]
      ? { externalMessageId: externalMessageIds[0] }
      : {}),
    ...(externalMessageIds.length > 0 ? { externalMessageIds } : {}),
    deliveredParts,
    totalParts: parts.length,
    ...(parts.length > 1
      ? { warnings: [`discord.message.chunked:${parts.length}`] }
      : {}),
  };
}

async function postDiscordFilesOrTextFallback(
  input: {
    channelId: string;
    files?: MessageFileAttachment[];
    apiRoot?: string;
    botToken?: string;
    post: DiscordMessagePoster;
  },
  body: Record<string, unknown>,
): Promise<{ id?: string }> {
  try {
    return await postDiscordFiles(
      input.apiRoot!,
      input.botToken!,
      input.channelId,
      body,
      input.files ?? [],
    );
  } catch {
    const posted = await input.post(input.channelId, body);
    await input
      .post(input.channelId, {
        content: 'Attachment unavailable in Discord: file upload failed.',
        allowed_mentions: { parse: [] },
      })
      .catch(() => undefined);
    return posted;
  }
}

async function postDiscordFiles(
  apiRoot: string,
  botToken: string,
  channelId: string,
  body: Record<string, unknown>,
  files: MessageFileAttachment[],
): Promise<{ id?: string }> {
  const uploads = files.filter(
    (file) => file.sizeBytes <= DISCORD_FILE_MAX_BYTES,
  );
  if (uploads.length === 0) return { id: undefined };
  const form = new FormData();
  form.set(
    'payload_json',
    JSON.stringify({
      ...body,
      attachments: uploads.map((file, id) => ({
        id,
        filename: file.filename,
        description: file.contentType,
      })),
    }),
  );
  uploads.forEach((file, index) => {
    form.set(
      `files[${index}]`,
      new Blob([file.content], { type: file.contentType }),
      file.filename,
    );
  });
  const response = await fetch(
    `${apiRoot}/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: 'POST',
      headers: { authorization: `Bot ${botToken}`, accept: 'application/json' },
      body: form,
    },
  );
  if (!response.ok) throw new Error('Discord file upload failed');
  return (await response.json()) as { id?: string };
}

// Prompt-message send used by permission and question interactions: a
// thread ID is itself the target channel for message-create.
export async function sendDiscordPromptMessage(
  post: (
    target: string,
    body: Record<string, unknown>,
  ) => Promise<{ id?: string }>,
  jid: string,
  text: string,
  options: { threadId?: string; components?: unknown[] } = {},
): Promise<MessageDeliveryResult> {
  const channelId = options.threadId || discordChannelIdFromJid(jid);
  if (!channelId) throw new Error(`Invalid Discord conversation id: ${jid}`);
  return postDiscordMessageParts({
    channelId,
    parts: splitDiscordText(text),
    components: options.components,
    post,
  });
}
