import { describe, expect, it } from 'vitest';
import {
  RICH_INTERACTION_FALLBACK_COPY,
  richFallbackText,
} from '@core/channels/rich-interaction.js';
import {
  buildDiscordRichInteractionFormModalResponse,
  buildDiscordRichInteractionPayload,
} from '@core/channels/discord/rich-interaction.js';
import { buildSlackRichInteractionBlocks } from '@core/channels/slack/rich-interaction.js';
import { buildTeamsRichInteractionPayload } from '@core/channels/teams/rich-interaction.js';
import { renderTelegramRichInteractionHtml } from '@core/channels/telegram/rich-interaction.js';
import { RICH_INTERACTION_NATIVE_FALLBACK_TEXT } from '@core/domain/types.js';
import type { RichInteractionRequest } from '@core/domain/types.js';

const request: RichInteractionRequest = {
  requestId: 'rich-1',
  sourceAgentFolder: 'main_agent',
  threadId: 'thread-1',
  descriptor: {
    id: 'descriptor-1',
    title: 'Lead brief',
    body: 'Qualified targets',
    rich: {
      kind: 'facts',
      fallbackText: 'Lead brief\nQualified targets',
      payload: {},
    },
    details: [{ label: 'Market', value: 'India' }],
    actions: [{ id: 'open', label: 'Open form', kind: 'open' }],
  },
};

describe('rich interaction provider renderers', () => {
  it('keeps the native fallback copy exact', () => {
    expect(RICH_INTERACTION_FALLBACK_COPY).toBe(
      RICH_INTERACTION_NATIVE_FALLBACK_TEXT,
    );
    expect(richFallbackText(request)).toBe('Lead brief\nQualified targets');
  });

  it('builds Slack blocks from the descriptor', () => {
    expect(buildSlackRichInteractionBlocks(request)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'header' }),
        expect.objectContaining({ type: 'section' }),
        expect.objectContaining({ type: 'actions' }),
      ]),
    );
  });

  it('renders rich payload content, not only legacy descriptor fields', () => {
    const tableRequest: RichInteractionRequest = {
      ...request,
      descriptor: {
        id: 'table-1',
        title: 'Pipeline',
        fallbackText: 'Pipeline fallback',
        rich: {
          kind: 'table',
          fallbackText: 'Pipeline fallback',
          payload: {
            columns: [{ key: 'name', label: 'Name' }],
            rows: [{ name: 'Acme' }],
          },
        },
      },
    };

    const slackTableBlocks = buildSlackRichInteractionBlocks(tableRequest);
    const slackTablePayload = JSON.stringify(slackTableBlocks);
    expect(slackTableBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'table',
          rows: expect.arrayContaining([
            expect.arrayContaining([
              expect.objectContaining({ type: 'raw_text', text: 'Name' }),
            ]),
          ]),
        }),
      ]),
    );
    expect(slackTablePayload).not.toContain('```');
    expect(slackTablePayload).toContain('Name');
    expect(slackTablePayload).toContain('Acme');
    expect(renderTelegramRichInteractionHtml(tableRequest).text).toContain(
      'Name: Acme',
    );
    expect(
      JSON.stringify(buildDiscordRichInteractionPayload(tableRequest)),
    ).toContain('Name: Acme');
    expect(
      JSON.stringify(buildTeamsRichInteractionPayload(tableRequest)),
    ).toContain('Name: Acme');
  });

  it('renders canonical list text/detail payload fields', () => {
    const listRequest: RichInteractionRequest = {
      ...request,
      descriptor: {
        id: 'list-1',
        title: 'Next steps',
        fallbackText: 'Next steps fallback',
        rich: {
          kind: 'list',
          fallbackText: 'Next steps fallback',
          payload: {
            items: [{ text: 'Call Ravi', detail: 'Tomorrow morning' }],
          },
        },
      },
    };

    const slackListPayload = JSON.stringify(
      buildSlackRichInteractionBlocks(listRequest),
    );
    expect(slackListPayload).toContain('"type":"rich_text_list"');
    expect(slackListPayload).toContain('"style":"bullet"');
    expect(slackListPayload).toContain('Call Ravi');
    expect(slackListPayload).toContain('Tomorrow morning');
    expect(slackListPayload).not.toContain('• *Call Ravi*');
  });

  it('renders Slack rich payloads as distinct component blocks', () => {
    const factsRequest: RichInteractionRequest = {
      ...request,
      descriptor: {
        id: 'facts-1',
        title: 'Facts',
        fallbackText: 'Facts fallback',
        rich: {
          kind: 'facts',
          fallbackText: 'Facts fallback',
          payload: {
            facts: [
              { label: 'Component', value: 'Facts card' },
              { label: 'Status', value: 'OK' },
            ],
          },
        },
      },
    };
    const listRequest: RichInteractionRequest = {
      ...request,
      descriptor: {
        id: 'list-1',
        title: 'List',
        fallbackText: 'List fallback',
        rich: {
          kind: 'list',
          fallbackText: 'List fallback',
          payload: {
            items: [{ text: 'First item' }, { text: 'Second item' }],
          },
        },
      },
    };
    const tableRequest: RichInteractionRequest = {
      ...request,
      descriptor: {
        id: 'table-1',
        title: 'Table',
        fallbackText: 'Table fallback',
        rich: {
          kind: 'table',
          fallbackText: 'Table fallback',
          payload: {
            columns: [
              { key: 'name', label: 'Name' },
              { key: 'value', label: 'Value' },
            ],
            rows: [
              { name: 'Alpha', value: 1 },
              { name: 'Beta', value: 2 },
            ],
          },
        },
      },
    };
    const progressRequest: RichInteractionRequest = {
      ...request,
      descriptor: {
        id: 'progress-1',
        title: 'Progress',
        fallbackText: 'Progress fallback',
        rich: {
          kind: 'progress',
          fallbackText: 'Progress fallback',
          payload: { label: 'Demo progress', value: 60 },
        },
      },
    };

    expect(buildSlackRichInteractionBlocks(factsRequest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'section',
          fields: expect.arrayContaining([
            expect.objectContaining({
              text: expect.stringContaining('*Component*'),
            }),
          ]),
        }),
      ]),
    );
    expect(
      JSON.stringify(buildSlackRichInteractionBlocks(listRequest)),
    ).toContain('"type":"rich_text_list"');
    const tablePayload = JSON.stringify(
      buildSlackRichInteractionBlocks(tableRequest),
    );
    expect(tablePayload).toContain('"type":"table"');
    expect(tablePayload).toContain('"text":"1"');
    expect(tablePayload).not.toContain('raw_number');
    expect(tablePayload).not.toContain('```');
    const progressPayload = JSON.stringify(
      buildSlackRichInteractionBlocks(progressRequest),
    );
    expect(progressPayload).toContain('large_green_square');
    expect(progressPayload).toContain('white_large_square');
    expect(progressPayload).toContain('60%');
  });

  it('renders status payload body and provider form fields', () => {
    const statusRequest: RichInteractionRequest = {
      ...request,
      descriptor: {
        id: 'status-1',
        title: 'Status',
        fallbackText: 'Status fallback',
        rich: {
          kind: 'status',
          fallbackText: 'Status fallback',
          payload: { status: 'success', body: 'Ready to submit' },
        },
      },
    };
    const formRequest: RichInteractionRequest = {
      ...request,
      descriptor: {
        id: 'form-1',
        title: 'Lead form',
        fallbackText: 'Lead form fallback',
        rich: {
          kind: 'form',
          fallbackText: 'Lead form fallback',
          payload: {
            fields: [{ id: 'company', label: 'Company', required: true }],
          },
        },
      },
    };

    expect(
      JSON.stringify(buildSlackRichInteractionBlocks(statusRequest)),
    ).toContain('Ready to submit');
    expect(
      JSON.stringify(buildDiscordRichInteractionFormModalResponse(formRequest)),
    ).toContain('Company');
    const teamsFormPayload = JSON.stringify(
      buildTeamsRichInteractionPayload(formRequest),
    );
    expect(teamsFormPayload).toContain('Input.Text');
    expect(teamsFormPayload).toContain('Company');
    expect(teamsFormPayload).toContain('Action.Submit');
  });

  it('renders Telegram HTML and inline buttons', () => {
    const payload = renderTelegramRichInteractionHtml(request);
    expect(payload.text).toContain('<b>Lead brief</b>');
    expect(payload.reply_markup).toEqual(
      expect.objectContaining({ inline_keyboard: expect.any(Array) }),
    );
  });

  it('builds Discord embed payloads', () => {
    const payload = buildDiscordRichInteractionPayload(request);
    expect(payload.embeds[0]).toEqual(
      expect.objectContaining({
        title: 'Lead brief',
        description: expect.stringContaining('Qualified targets'),
      }),
    );
    expect(payload.components).toHaveLength(1);
  });

  it('builds Teams Adaptive Card payloads', () => {
    const payload = buildTeamsRichInteractionPayload(request);
    expect(payload.attachments[0]).toEqual(
      expect.objectContaining({
        contentType: 'application/vnd.microsoft.card.adaptive',
      }),
    );
    expect(payload.attachments[0].content).toEqual(
      expect.objectContaining({ type: 'AdaptiveCard' }),
    );
  });
});
