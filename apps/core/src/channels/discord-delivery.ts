import type {
  MessageDeliveryResult,
  MessageFileAttachment,
} from '../domain/types.js';
import type { AgentTodoRender } from '../domain/ports/task-lifecycle.js';
import { PartialMessageDeliveryError } from '../domain/messages/partial-delivery.js';
import {
  agentTodoLines,
  formatAgentProgressLine,
  formatAgentTodoHeader,
  hasAgentTodoCardHeader,
} from './agent-todo-render.js';

const DISCORD_MESSAGE_MAX_LENGTH = 2000;
const DISCORD_FILE_MAX_BYTES = 25 * 1024 * 1024;
const DISCORD_TODO_MAX_LENGTH = 1900;

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

export async function postDiscordMessageParts(input: {
  channelId: string;
  parts: string[];
  components?: unknown[];
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
        content: parts[index],
        allowed_mentions: { parse: [] },
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
