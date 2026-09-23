import type { RichInteractionRequest } from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { slackThreadTsFromThreadId } from './thread-ts.js';
import {
  isRichForm,
  richDescriptor,
  RICH_INTERACTION_CANCEL_LABEL,
  RICH_INTERACTION_FALLBACK_COPY,
  RICH_INTERACTION_OPEN_FORM_LABEL,
  RICH_INTERACTION_REQUIRED_FIELDS_COPY,
  RICH_INTERACTION_SUBMIT_LABEL,
  RICH_INTERACTION_SUBMITTED_BY_COPY,
  richArrayItems,
  richFallbackText,
  richSlackEscape,
  richTruncate,
} from '../rich-interaction.js';

export function buildSlackRichInteractionBlocks(
  input: RichInteractionRequest,
): Array<Record<string, unknown>> {
  const item = richDescriptor(input);
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: richTruncate(item.title, 150),
        emoji: true,
      },
    },
  ];
  blocks.push(...slackRichPayloadBlocks(input));
  if (item.actions?.length) {
    blocks.push({
      type: 'actions',
      elements: item.actions.slice(0, 5).map((action) => ({
        type: 'button',
        text: {
          type: 'plain_text',
          text: richTruncate(action.label, 75),
          emoji: true,
        },
        action_id: `gantry_rich_${action.id}`,
        value: JSON.stringify({ interactionId: item.id, actionId: action.id }),
        style:
          action.style === 'danger'
            ? 'danger'
            : action.style === 'primary'
              ? 'primary'
              : undefined,
      })),
    });
  }
  if (isRichForm(input)) {
    blocks.push(
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: richSlackEscape(RICH_INTERACTION_REQUIRED_FIELDS_COPY),
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: RICH_INTERACTION_OPEN_FORM_LABEL,
              emoji: true,
            },
            action_id: 'gantry_rich_form_open',
            value: item.id,
            style: 'primary',
          },
        ],
      },
    );
  }
  return blocks;
}

function slackRichPayloadBlocks(
  input: RichInteractionRequest,
): Array<Record<string, unknown>> {
  const item = richDescriptor(input);
  const payload = item.rich?.payload ?? {};
  const bodyBlocks = item.body
    ? [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: richTruncate(richSlackEscape(item.body), 2900),
          },
        },
      ]
    : [];
  switch (item.rich?.kind) {
    case 'status':
      return [
        ...bodyBlocks,
        slackStatusBlock(payload.status ?? payload.state, payload.body),
      ];
    case 'facts':
      return [
        ...bodyBlocks,
        ...fieldSections(
          richArrayItems(payload.facts).map((fact) => ({
            label: scalarText(fact.label) || 'Fact',
            value: scalarText(fact.value) || '-',
          })),
        ),
        ...detailFieldSections(input),
      ];
    case 'list':
      return [
        ...bodyBlocks,
        slackListBlock(richArrayItems(payload.items), payload.ordered === true),
      ];
    case 'table':
      return [...bodyBlocks, slackTableBlock(payload)];
    case 'progress':
      return [
        ...bodyBlocks,
        slackProgressBlock(
          scalarText(payload.label),
          typeof payload.value === 'number' ? payload.value : undefined,
          payload.done === true,
        ),
      ];
    case 'media':
      return [
        ...bodyBlocks,
        slackSection(
          richArrayItems(payload.items)
            .slice(0, 10)
            .map((mediaItem) => {
              const label =
                scalarText(mediaItem.caption) ||
                scalarText(mediaItem.alt) ||
                scalarText(mediaItem.mime_type) ||
                'Media';
              const url = scalarText(mediaItem.url);
              return url
                ? `• <${richSlackEscape(url)}|${richSlackEscape(label)}>`
                : `• ${richSlackEscape(label)}`;
            })
            .join('\n'),
          false,
        ),
      ];
    case 'form':
      return [
        ...bodyBlocks,
        slackSection(
          richArrayItems(payload.fields)
            .slice(0, 10)
            .map((field) => {
              const label = scalarText(field.label || field.id) || 'Field';
              return `• *${richSlackEscape(label)}*`;
            })
            .join('\n'),
        ),
      ];
    default:
      return [
        ...bodyBlocks,
        ...detailFieldSections(input),
        ...(bodyBlocks.length || item.details?.length
          ? []
          : [slackSection(richFallbackText(input))]),
      ];
  }
}

function slackSection(text: string, escape = true): Record<string, unknown> {
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: richTruncate(
        escape ? richSlackEscape(text || '-') : text || '-',
        2900,
      ),
    },
  };
}

function fieldSections(
  fields: Array<{ label: string; value: string }>,
): Array<Record<string, unknown>> {
  const sections: Array<Record<string, unknown>> = [];
  for (let index = 0; index < fields.length; index += 10) {
    const slice = fields.slice(index, index + 10);
    if (!slice.length) continue;
    sections.push({
      type: 'section',
      fields: slice.map((field) => ({
        type: 'mrkdwn',
        text: `*${richSlackEscape(field.label)}*\n${richSlackEscape(field.value)}`,
      })),
    });
  }
  return sections;
}

function detailFieldSections(
  input: RichInteractionRequest,
): Array<Record<string, unknown>> {
  return fieldSections(
    (richDescriptor(input).details ?? []).slice(0, 10).map((detail) => ({
      label: detail.label,
      value: detail.value,
    })),
  );
}

function scalarText(value: unknown): string {
  return ['string', 'number', 'boolean'].includes(typeof value)
    ? String(value)
    : '';
}

function slackStatusBlock(
  statusValue: unknown,
  bodyValue: unknown,
): Record<string, unknown> {
  const status = scalarText(statusValue);
  const body = scalarText(bodyValue);
  const elements: Array<Record<string, unknown>> = [];
  if (status) {
    elements.push(
      { type: 'emoji', name: slackStatusEmojiName(status) },
      { type: 'text', text: ` ${status}`, style: { bold: true } },
    );
  }
  if (body)
    elements.push({ type: 'text', text: `${status ? '\n' : ''}${body}` });
  return slackRichTextSectionBlock(elements);
}

function slackStatusEmojiName(status: string): string {
  return status === 'success'
    ? 'white_check_mark'
    : status === 'warning'
      ? 'warning'
      : status === 'error'
        ? 'x'
        : 'information_source';
}

function slackListBlock(
  items: Array<Record<string, unknown>>,
  ordered: boolean,
): Record<string, unknown> {
  const elements = items.slice(0, 30).map(slackListItem).filter(Boolean);
  if (!elements.length) return slackSection('-');
  return {
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_list',
        style: ordered ? 'ordered' : 'bullet',
        elements,
      },
    ],
  };
}

function slackListItem(
  item: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const title = scalarText(item.text) || scalarText(item.title);
  const detail = scalarText(item.detail) || scalarText(item.description);
  if (!title && !detail) return undefined;
  const elements: Array<Record<string, unknown>> = [];
  if (title) {
    elements.push({
      type: 'text',
      text: richTruncate(title, 300),
      ...(detail ? { style: { bold: true } } : {}),
    });
  }
  if (detail) {
    elements.push({
      type: 'text',
      text: richTruncate(title ? ` - ${detail}` : detail, 500),
    });
  }
  return { type: 'rich_text_section', elements };
}

function slackTableBlock(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const columns = richArrayItems(payload.columns).slice(0, 6);
  const rows = richArrayItems(payload.rows).slice(0, 12);
  const labels = columns
    .map((column) => {
      const key = scalarText(column.key);
      return key ? { key, label: scalarText(column.label) || key } : undefined;
    })
    .filter((column): column is { key: string; label: string } =>
      Boolean(column),
    );
  if (!labels.length || !rows.length) return slackSection('-');
  return {
    type: 'table',
    column_settings: labels.map((column) => ({
      is_wrapped: true,
      ...(rows.every((row) => typeof row[column.key] === 'number')
        ? { align: 'right' }
        : {}),
    })),
    rows: [
      labels.map((column) => slackRawTextCell(column.label)),
      ...rows.map((row) =>
        labels.map((column) => slackTableCell(row[column.key])),
      ),
    ],
  };
}

function slackRawTextCell(value: string): Record<string, unknown> {
  return { type: 'raw_text', text: richTruncate(value || '-', 300) };
}

function slackTableCell(value: unknown): Record<string, unknown> {
  return slackRawTextCell(scalarText(value) || '-');
}

function slackProgressBlock(
  label: string,
  value: number | undefined,
  done: boolean,
): Record<string, unknown> {
  const normalized = done ? 100 : Math.max(0, Math.min(100, value ?? 0));
  const filled = Math.round(normalized / 10);
  const empty = 10 - filled;
  const elements: Array<Record<string, unknown>> = [];
  if (label) elements.push({ type: 'text', text: `${label}\n` });
  for (let index = 0; index < filled; index += 1) {
    elements.push({ type: 'emoji', name: 'large_green_square' });
  }
  for (let index = 0; index < empty; index += 1) {
    elements.push({ type: 'emoji', name: 'white_large_square' });
  }
  elements.push({
    type: 'text',
    text: ` ${normalized}%`,
    style: { bold: true },
  });
  return slackRichTextSectionBlock(elements);
}

function slackRichTextSectionBlock(
  elements: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_section',
        elements: elements.length ? elements : [{ type: 'text', text: '-' }],
      },
    ],
  };
}

export async function renderSlackRichInteraction(input: {
  app: any;
  jid: string;
  channelId: string;
  render: RichInteractionRequest;
  pendingRichForms: Map<string, RichInteractionRequest>;
  sendFallback: (
    text: string,
    options: { threadId?: string },
  ) => Promise<unknown>;
}): Promise<boolean> {
  const { app, jid, channelId, render, pendingRichForms, sendFallback } = input;
  try {
    if (isRichForm(render)) pendingRichForms.set(render.descriptor.id, render);
    await app.client.chat.postMessage({
      channel: channelId,
      text: richFallbackText(render),
      blocks: buildSlackRichInteractionBlocks(render) as any,
      ...(slackThreadTsFromThreadId(render.threadId)
        ? { thread_ts: slackThreadTsFromThreadId(render.threadId) }
        : {}),
    });
    return true;
  } catch (err) {
    logger.warn({ jid, err }, 'Slack rich interaction render failed');
    await sendFallback(
      `${RICH_INTERACTION_FALLBACK_COPY}\n\n${richFallbackText(render)}`,
      { threadId: render.threadId },
    );
    return true;
  }
}

export function registerSlackRichFormHandlers(input: {
  app: any;
  pendingRichForms: Map<string, RichInteractionRequest>;
  onSubmit: (input: {
    request: RichInteractionRequest;
    channelId: string;
    threadTs: string;
    userId: string;
    text: string;
  }) => Promise<void>;
}): void {
  const { app, pendingRichForms, onSubmit } = input;
  app.action('gantry_rich_form_open', async (args: any) => {
    await args.ack();
    const action = args.action as { value?: string };
    const body = args.body as {
      channel?: { id?: string };
      message?: { ts?: string; thread_ts?: string };
      trigger_id?: string;
    };
    if (!body.trigger_id) return;
    const request = pendingRichForms.get(action.value || '');
    if (!request) return;
    const payload = request.descriptor.rich?.payload ?? {};
    const fields = Array.isArray(payload.fields) ? payload.fields : [];
    await app.client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'gantry_rich_form_modal',
        private_metadata: JSON.stringify({
          channelId: body.channel?.id || '',
          interactionId: request.descriptor.id,
          threadTs: body.message?.thread_ts || body.message?.ts || '',
        }),
        title: {
          type: 'plain_text',
          text: (
            request.descriptor.title || RICH_INTERACTION_OPEN_FORM_LABEL
          ).slice(0, 24),
        },
        submit: { type: 'plain_text', text: RICH_INTERACTION_SUBMIT_LABEL },
        close: { type: 'plain_text', text: RICH_INTERACTION_CANCEL_LABEL },
        blocks: fields.length
          ? fields.slice(0, 10).map((field, index) => {
              const item =
                typeof field === 'object' && field !== null
                  ? (field as Record<string, unknown>)
                  : {};
              return {
                type: 'input',
                block_id: `gantry_rich_form_${index}`,
                optional: item.required !== true,
                label: {
                  type: 'plain_text',
                  text: String(
                    item.label || item.id || `Field ${index + 1}`,
                  ).slice(0, 150),
                },
                element: {
                  type: 'plain_text_input',
                  action_id: 'value',
                  multiline: item.type === 'textarea',
                },
              };
            })
          : [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: RICH_INTERACTION_REQUIRED_FIELDS_COPY,
                },
              },
            ],
      },
    });
  });
  app.view('gantry_rich_form_modal', async (args: any) => {
    await args.ack();
    const body = args.body as {
      user?: { id?: string; name?: string; username?: string };
    };
    const view = args.view as {
      private_metadata?: string;
      state?: { values?: Record<string, { value?: { value?: string } }> };
    };
    let meta: { channelId?: string; interactionId?: string; threadTs?: string };
    try {
      meta = JSON.parse(view.private_metadata || '{}');
    } catch {
      return;
    }
    if (!meta.channelId || !meta.interactionId || !body.user?.id) return;
    const request = pendingRichForms.get(meta.interactionId);
    if (!request) return;
    pendingRichForms.delete(meta.interactionId);
    const fields = richArrayItems(request.descriptor.rich?.payload.fields);
    const answers = fields
      .map((field, index) => {
        const value =
          view.state?.values?.[
            `gantry_rich_form_${index}`
          ]?.value?.value?.trim();
        return value ? `${String(field.label || field.id)}: ${value}` : null;
      })
      .filter((answer): answer is string => Boolean(answer));
    if (!answers.length) return;
    try {
      await onSubmit({
        request,
        channelId: meta.channelId,
        threadTs: meta.threadTs || '',
        userId: body.user.id,
        text: `Form submitted for ${request.descriptor.title}:\n${answers.join('\n')}`,
      });
    } catch (err) {
      logger.warn(
        { err, interactionId: meta.interactionId },
        'Slack form submission could not be routed',
      );
      await app.client.chat.postMessage({
        channel: meta.channelId,
        text: 'I could not process that form. Please reply with the details in this thread.',
        ...(meta.threadTs ? { thread_ts: meta.threadTs } : {}),
      });
      return;
    }
    const displayName =
      body.user?.name || body.user?.username || body.user?.id || 'unknown';
    await app.client.chat.postMessage({
      channel: meta.channelId,
      text: `${RICH_INTERACTION_SUBMITTED_BY_COPY} ${displayName}.`,
      ...(meta.threadTs ? { thread_ts: meta.threadTs } : {}),
    });
  });
}
