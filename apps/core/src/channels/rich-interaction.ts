import type {
  InteractionDescriptor,
  RichInteractionRequest,
} from '../domain/types.js';
import { RICH_INTERACTION_NATIVE_FALLBACK_TEXT } from '../domain/types.js';
import { TEAMS_ADAPTIVE_CARD_CONTENT_TYPE } from './teams-cards.js';

export const RICH_INTERACTION_FALLBACK_COPY =
  RICH_INTERACTION_NATIVE_FALLBACK_TEXT;
export const RICH_INTERACTION_OPEN_FORM_LABEL = 'Open form';
export const RICH_INTERACTION_SUBMIT_LABEL = 'Submit';
export const RICH_INTERACTION_CANCEL_LABEL = 'Cancel';
export const RICH_INTERACTION_REQUIRED_FIELDS_COPY =
  'Complete the required fields before submitting.';
export const RICH_INTERACTION_SUBMITTED_BY_COPY = 'Submitted by';

type RichDescriptor = InteractionDescriptor & {
  kind?: string;
  fallbackText?: string;
};

function descriptor(input: RichInteractionRequest): RichDescriptor {
  return input.descriptor;
}

export function richFallbackText(input: RichInteractionRequest): string {
  const item = descriptor(input);
  return (
    item.rich?.fallbackText || item.fallbackText || item.body || item.title
  );
}

function textLines(input: RichInteractionRequest): string[] {
  const item = descriptor(input);
  const lines = [item.title, item.body].filter(Boolean) as string[];
  for (const detail of item.details ?? []) {
    lines.push(`${detail.label}: ${detail.value}`);
  }
  for (const option of item.options ?? []) {
    lines.push(
      `- ${option.label}${option.description ? `: ${option.description}` : ''}`,
    );
  }
  if (item.result?.message) lines.push(item.result.message);
  return lines.length ? lines : [richFallbackText(input)];
}

function slackEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function htmlEscape(text: string): string {
  return slackEscape(text).replace(/"/g, '&quot;');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isForm(input: RichInteractionRequest): boolean {
  return descriptor(input).rich?.kind === 'form';
}

function payloadLines(input: RichInteractionRequest): string[] {
  const rich = descriptor(input).rich;
  const payload = rich?.payload ?? {};
  switch (rich?.kind) {
    case 'status':
      return [
        typeof payload.state === 'string' ? payload.state : '',
        typeof payload.status === 'string' ? payload.status : '',
        typeof payload.body === 'string' ? payload.body : '',
      ].filter(Boolean);
    case 'facts':
      return arrayItems(payload.facts)
        .map((fact) => lineFromPair(fact, 'label', 'value'))
        .filter(Boolean);
    case 'list':
      return arrayItems(payload.items)
        .map(
          (item) =>
            lineFromPair(item, 'text', 'detail') ||
            lineFromPair(item, 'title', 'description'),
        )
        .filter(Boolean);
    case 'table':
      return tableLines(payload);
    case 'form':
      return [
        RICH_INTERACTION_REQUIRED_FIELDS_COPY,
        ...arrayItems(payload.fields)
          .map((field) => lineFromPair(field, 'label', 'type'))
          .filter(Boolean),
      ];
    case 'media':
      return arrayItems(payload.items)
        .map((item) => {
          const label = item.caption || item.alt || item.mime_type || 'Media';
          return lineFromPair({ ...item, label }, 'label', 'url');
        })
        .filter(Boolean);
    case 'progress':
      return [
        typeof payload.label === 'string' ? payload.label : '',
        typeof payload.value === 'number' ? `${payload.value}%` : '',
      ].filter(Boolean);
    default:
      return [];
  }
}

function arrayItems(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && !Array.isArray(item),
      )
    : [];
}

function lineFromPair(
  item: Record<string, unknown>,
  labelKey: string,
  valueKey: string,
): string {
  const label = item[labelKey];
  const value = item[valueKey];
  return [label, value]
    .filter((part): part is string | number | boolean =>
      ['string', 'number', 'boolean'].includes(typeof part),
    )
    .map(String)
    .join(': ');
}

function tableLines(payload: Record<string, unknown>): string[] {
  const columns = arrayItems(payload.columns);
  const rows = arrayItems(payload.rows);
  const keys = columns
    .map((column) => column.key)
    .filter((key): key is string => typeof key === 'string');
  return rows.slice(0, 10).map((row) =>
    keys
      .map((key) => {
        const label =
          columns.find((column) => column.key === key)?.label ?? key;
        return `${label}: ${String(row[key] ?? '')}`;
      })
      .join(' | '),
  );
}

function richTextLines(input: RichInteractionRequest): string[] {
  return [...textLines(input), ...payloadLines(input)].filter(Boolean);
}

function formFields(input: RichInteractionRequest): Record<string, unknown>[] {
  return isForm(input)
    ? arrayItems(descriptor(input).rich?.payload.fields).slice(0, 5)
    : [];
}

export function buildSlackRichInteractionBlocks(
  input: RichInteractionRequest,
): Array<Record<string, unknown>> {
  const item = descriptor(input);
  const richLines = richTextLines(input);
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: truncate(item.title, 150),
        emoji: true,
      },
    },
  ];
  const body = richLines.slice(1).join('\n');
  if (body) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(slackEscape(body), 2900) },
    });
  }
  if (item.details?.length) {
    blocks.push({
      type: 'section',
      fields: item.details.slice(0, 10).map((detail) => ({
        type: 'mrkdwn',
        text: `*${slackEscape(detail.label)}*\n${slackEscape(detail.value)}`,
      })),
    });
  }
  if (item.actions?.length) {
    blocks.push({
      type: 'actions',
      elements: item.actions.slice(0, 5).map((action) => ({
        type: 'button',
        text: {
          type: 'plain_text',
          text: truncate(action.label, 75),
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
  if (isForm(input)) {
    blocks.push(
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: slackEscape(RICH_INTERACTION_REQUIRED_FIELDS_COPY),
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

export function buildSlackRichInteractionFormModal(
  input: RichInteractionRequest,
): Record<string, unknown> {
  const item = descriptor(input);
  return {
    type: 'modal',
    callback_id: `gantry_rich_form_${item.id}`,
    title: {
      type: 'plain_text',
      text: truncate(item.title || RICH_INTERACTION_OPEN_FORM_LABEL, 24),
    },
    submit: { type: 'plain_text', text: RICH_INTERACTION_SUBMIT_LABEL },
    close: { type: 'plain_text', text: RICH_INTERACTION_CANCEL_LABEL },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: slackEscape(RICH_INTERACTION_REQUIRED_FIELDS_COPY),
        },
      },
    ],
  };
}

export function renderTelegramRichInteractionHtml(
  input: RichInteractionRequest,
): { text: string; reply_markup?: Record<string, unknown> } {
  const item = descriptor(input);
  const text = richTextLines(input)
    .map((line, index) =>
      index === 0 ? `<b>${htmlEscape(line)}</b>` : htmlEscape(line),
    )
    .join('\n');
  const actions = item.actions?.slice(0, 8).map((action) => ({
    text: action.label,
    callback_data: `rich:${item.id}:${action.id}`.slice(0, 64),
  }));
  return {
    text,
    ...(actions?.length
      ? { reply_markup: { inline_keyboard: actions.map((action) => [action]) } }
      : {}),
  };
}

export function buildDiscordRichInteractionPayload(
  input: RichInteractionRequest,
): { content: string; embeds: unknown[]; components?: unknown[] } {
  const item = descriptor(input);
  const richLines = richTextLines(input);
  const fields = item.details?.slice(0, 25).map((detail) => ({
    name: truncate(detail.label, 256),
    value: truncate(detail.value, 1024) || ' ',
    inline: true,
  }));
  const components = item.actions?.length
    ? [
        {
          type: 1,
          components: item.actions.slice(0, 5).map((action) => ({
            type: 2,
            label: truncate(action.label, 80),
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
  const formComponents = isForm(input)
    ? [
        {
          type: 1,
          components: [
            {
              type: 2,
              label: RICH_INTERACTION_OPEN_FORM_LABEL,
              style: 1,
              custom_id: `gantry:rich_form_open:${item.id}`.slice(0, 100),
            },
          ],
        },
      ]
    : undefined;
  return {
    content: '',
    embeds: [
      {
        title: truncate(item.title, 256),
        description: truncate(
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
  const item = descriptor(input);
  const fields = arrayItems(item.rich?.payload.fields).slice(0, 5);
  return {
    type: 9,
    data: {
      custom_id: `gantry:rich_form_submit:${item.id}`.slice(0, 100),
      title: truncate(item.title || RICH_INTERACTION_OPEN_FORM_LABEL, 45),
      components: (fields.length
        ? fields
        : [{ label: RICH_INTERACTION_OPEN_FORM_LABEL }]
      ).map((field, index) => ({
        type: 1,
        components: [
          {
            type: 4,
            custom_id: `field_${index}`,
            label: truncate(
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

export function buildTeamsRichInteractionPayload(
  input: RichInteractionRequest,
): {
  attachments: [{ contentType: string; content: Record<string, unknown> }];
} {
  const item = descriptor(input);
  const fields = formFields(input);
  const body: Record<string, unknown>[] = richTextLines(input).map(
    (line, index) => ({
      type: 'TextBlock',
      text: line,
      wrap: true,
      ...(index === 0 ? { size: 'Medium', weight: 'Bolder' } : {}),
    }),
  );
  if (fields.length) {
    body.push(
      ...fields.map((field, index) => ({
        type: 'Input.Text',
        id: String(field.id || `field_${index}`),
        label: String(field.label || field.id || `Field ${index + 1}`),
        isMultiline: field.type === 'textarea',
        isRequired: field.required === true,
      })),
    );
  }
  const actions: Record<string, unknown>[] = (item.actions ?? [])
    .slice(0, 5)
    .map((action) => ({
      type: action.kind === 'submit' ? 'Action.Submit' : 'Action.Execute',
      title: action.label,
      verb: 'gantry.rich.action',
      data: {
        action: 'rich_interaction',
        interactionId: item.id,
        actionId: action.id,
      },
    }));
  if (fields.length) {
    actions.push({
      type: 'Action.Submit',
      title: RICH_INTERACTION_SUBMIT_LABEL,
      verb: 'gantry.rich.form.submit',
      data: {
        action: 'rich_form_submit',
        interactionId: item.id,
      },
    });
  }
  return {
    attachments: [
      {
        contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.5',
          body,
          actions,
        },
      },
    ],
  };
}
