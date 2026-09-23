import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import {
  buildSlackRichInteractionBlocks,
  registerSlackRichFormHandlers,
} from '@core/channels/slack/rich-interaction.js';
import { richTextLines } from '@core/channels/rich-interaction.js';
import type { RichInteractionRequest } from '@core/domain/types.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);

const fallbackCopy =
  'Rich view unavailable in this conversation. Showing text version.';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('generative UI provider renderers', () => {
  it('shows form field labels without exposing input types', () => {
    const request = {
      descriptor: {
        id: 'claim-details',
        title: 'Claim Details for MOTOR-1001',
        rich: {
          kind: 'form',
          payload: {
            fields: [
              { id: 'incident_type', label: 'Incident type', type: 'text' },
              {
                id: 'description',
                label: 'Brief description',
                type: 'textarea',
              },
            ],
          },
        },
      },
    } as RichInteractionRequest;

    const blocks = JSON.stringify(buildSlackRichInteractionBlocks(request));
    expect(blocks).toContain('Incident type');
    expect(blocks).toContain('Brief description');
    expect(blocks).not.toContain('(text)');
    expect(blocks).not.toContain('(textarea)');
    expect(richTextLines(request)).toEqual([
      'Claim Details for MOTOR-1001',
      'Complete the required fields before submitting.',
      'Incident type',
      'Brief description',
    ]);
  });

  it('passes submitted Slack form values back to the active agent thread once', async () => {
    const handlers = new Map<string, (args: unknown) => Promise<void>>();
    const postMessage = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const request = {
      requestId: 'request-1',
      sourceAgentFolder: 'mia',
      descriptor: {
        id: 'form-1',
        title: 'Claim details',
        rich: {
          kind: 'form',
          fallbackText: 'Please provide claim details.',
          payload: {
            fields: [
              {
                id: 'incident_date',
                label: 'Incident date',
                type: 'text',
                required: true,
              },
              {
                id: 'description',
                label: 'Description',
                type: 'textarea',
                required: true,
              },
            ],
          },
        },
      },
    } as RichInteractionRequest;
    registerSlackRichFormHandlers({
      app: {
        action: () => undefined,
        view: (name: string, handler: (args: unknown) => Promise<void>) =>
          handlers.set(name, handler),
        client: { chat: { postMessage } },
      },
      pendingRichForms: new Map([['form-1', request]]),
      onSubmit,
    });
    const submission = {
      ack: vi.fn(),
      body: { user: { id: 'U123', name: 'Customer' } },
      view: {
        private_metadata: JSON.stringify({
          channelId: 'C123',
          interactionId: 'form-1',
          threadTs: '123.456',
        }),
        state: {
          values: {
            gantry_rich_form_0: { value: { value: '28 August 2026' } },
            gantry_rich_form_1: {
              value: { value: 'I hit a pillar while parking' },
            },
          },
        },
      },
    };
    await handlers.get('gantry_rich_form_modal')!(submission);
    await handlers.get('gantry_rich_form_modal')!(submission);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'C123',
        threadTs: '123.456',
        userId: 'U123',
        text: 'Form submitted for Claim details:\nIncident date: 28 August 2026\nDescription: I hit a pillar while parking',
      }),
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        text: 'Submitted by Customer.',
        thread_ts: '123.456',
      }),
    );
  });

  it('uses the exact native-render fallback copy across provider renderers', () => {
    for (const file of [
      'apps/core/src/channels/rich-interaction.ts',
      'apps/core/src/channels/slack/rich-interaction.ts',
      'apps/core/src/channels/discord/rich-interaction.ts',
    ]) {
      const source = read(file);
      expect(
        source.includes(fallbackCopy) ||
          source.includes('RICH_INTERACTION_FALLBACK_COPY'),
        file,
      ).toBe(true);
    }
  });

  it('keeps Slack multi-field and free-text forms behind an Open form modal', () => {
    const slackSources = [
      read('apps/core/src/channels/rich-interaction.ts'),
      read('apps/core/src/channels/slack/channel-delivery.ts'),
      read('apps/core/src/channels/slack/channel-interactions.ts'),
      read('apps/core/src/channels/slack/rich-interaction.ts'),
      read('apps/core/src/channels/slack/permission-blocks.ts'),
    ].join('\n');

    expect(slackSources).toContain('Open form');
    expect(slackSources).toContain('Submit');
    expect(slackSources).toContain('Cancel');
    expect(slackSources).toContain(
      'Complete the required fields before submitting.',
    );
    expect(slackSources).toContain('Submitted by');
    expect(slackSources).toMatch(/views\.open|type:\s*'modal'|type:\s*"modal"/);
  });

  it('keeps Discord multi-field and free-text forms behind interaction modals', () => {
    const discord = [
      read('apps/core/src/channels/rich-interaction.ts'),
      read('apps/core/src/channels/discord/index.ts'),
      read('apps/core/src/channels/discord/rich-interaction.ts'),
    ].join('\n');

    expect(discord).toContain('Open form');
    expect(discord).toContain('Submit');
    expect(discord).toContain('Cancel');
    expect(discord).toContain(
      'Complete the required fields before submitting.',
    );
    expect(discord).toContain('Submitted by');
    expect(discord).toMatch(/interaction/i);
    expect(discord).toMatch(/modal|type:\s*9/);
  });
});
