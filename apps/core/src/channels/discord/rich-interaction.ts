import type { RichInteractionRequest } from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  isRichForm,
  richArrayItems,
  richDescriptor,
  RICH_INTERACTION_FALLBACK_COPY,
  RICH_INTERACTION_OPEN_FORM_LABEL,
  richFallbackText,
  richTextLines,
  richTruncate,
} from '../rich-interaction.js';

export const DISCORD_RICH_FORM_OPEN_PREFIX = 'gantry:rich_form_open:';

export function buildDiscordRichInteractionPayload(
  input: RichInteractionRequest,
): { content: string; embeds: unknown[]; components?: unknown[] } {
  const item = richDescriptor(input);
  const richLines = richTextLines(input);
  const fields = item.details?.slice(0, 25).map((detail) => ({
    name: richTruncate(detail.label, 256),
    value: richTruncate(detail.value, 1024) || ' ',
    inline: true,
  }));
  const components = item.actions?.length
    ? [
        {
          type: 1,
          components: item.actions.slice(0, 5).map((action) => ({
            type: 2,
            label: richTruncate(action.label, 80),
            style:
              action.style === 'danger'
                ? 4
                : action.style === 'primary'
                  ? 1
                  : 2,
            custom_id: `gantry:rich:${item.id}:${action.id}`.slice(0, 100),
          })),
        },
      ]
    : undefined;
  const formComponents = isRichForm(input)
    ? [
        {
          type: 1,
          components: [
            {
              type: 2,
              label: RICH_INTERACTION_OPEN_FORM_LABEL,
              style: 1,
              custom_id: `${DISCORD_RICH_FORM_OPEN_PREFIX}${item.id}`.slice(
                0,
                100,
              ),
            },
          ],
        },
      ]
    : undefined;
  return {
    content: '',
    embeds: [
      {
        title: richTruncate(item.title, 256),
        description: richTruncate(
          richLines.slice(1).join('\n') || richFallbackText(input),
          4096,
        ),
        fields,
      },
    ],
    components: formComponents ?? components,
  };
}

export function buildDiscordRichInteractionFormModalResponse(
  input: RichInteractionRequest,
): Record<string, unknown> {
  const item = richDescriptor(input);
  const fields = richArrayItems(item.rich?.payload.fields).slice(0, 5);
  return {
    type: 9,
    data: {
      custom_id: `gantry:rich_form_submit:${item.id}`.slice(0, 100),
      title: richTruncate(item.title || RICH_INTERACTION_OPEN_FORM_LABEL, 45),
      components: (fields.length
        ? fields
        : [{ label: RICH_INTERACTION_OPEN_FORM_LABEL }]
      ).map((field, index) => ({
        type: 1,
        components: [
          {
            type: 4,
            custom_id: `field_${index}`,
            label: richTruncate(
              String(field.label || field.id || `Field ${index + 1}`),
              45,
            ),
            style: field.type === 'textarea' ? 2 : 1,
            required: field.required === true,
          },
        ],
      })),
    },
  };
}

export async function renderDiscordRichInteraction(input: {
  jid: string;
  channelId: string | null;
  render: RichInteractionRequest;
  richForms: Map<string, RichInteractionRequest>;
  postMessage: (
    channelId: string,
    body: Record<string, unknown>,
  ) => Promise<unknown>;
  sendFallback: (
    text: string,
    options: { threadId?: string },
  ) => Promise<unknown>;
}): Promise<boolean> {
  const { jid, channelId, render, richForms, postMessage, sendFallback } =
    input;
  if (!channelId) return false;
  try {
    if (isRichForm(render)) richForms.set(render.descriptor.id, render);
    await postMessage(channelId, buildDiscordRichInteractionPayload(render));
    return true;
  } catch (err) {
    logger.warn({ jid, err }, 'Discord rich interaction render failed');
    await sendFallback(
      `${RICH_INTERACTION_FALLBACK_COPY}\n\n${richFallbackText(render)}`,
      { threadId: render.threadId },
    );
    return true;
  }
}

export async function openDiscordRichFormInteraction(input: {
  apiRoot: string;
  headers: Record<string, string>;
  interaction: { id?: string; token?: string };
  customId: string;
  richForms: Map<string, RichInteractionRequest>;
  ackInteraction: (message: string) => Promise<void>;
}): Promise<void> {
  const { apiRoot, headers, interaction, customId, richForms, ackInteraction } =
    input;
  const id = customId.slice(DISCORD_RICH_FORM_OPEN_PREFIX.length);
  const request = richForms.get(id);
  if (!request) {
    await ackInteraction('This form is no longer active.');
    return;
  }
  await fetch(
    `${apiRoot}/interactions/${encodeURIComponent(interaction.id || '')}/${encodeURIComponent(interaction.token || '')}/callback`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(
        buildDiscordRichInteractionFormModalResponse(request),
      ),
    },
  );
  richForms.delete(id);
}
