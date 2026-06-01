import { describe, expect, it } from 'vitest';

import {
  buildPermissionPromptParts,
  PERMISSION_GLYPH,
} from '@core/channels/permission-interaction.js';
import {
  escapeTelegramHtml,
  renderBodyLinesHtml,
  renderPermissionPromptHtml,
  renderUserQuestionPromptHtml,
} from '@core/channels/telegram/html-render.js';
import {
  buildPermissionPromptContentBlocks,
  buildPermissionReceiptBlocks,
} from '@core/channels/slack/permission-blocks.js';
import { truncateSlackText } from '@core/channels/slack/channel-user-question-utils.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';

const commandRequest: PermissionApprovalRequest = {
  requestId: 'permission_1',
  sourceAgentFolder: 'main_agent',
  toolName: 'Bash',
  toolInput: { command: 'npm test' },
};

describe('buildPermissionPromptParts', () => {
  it('splits a command prompt into title, fenced body, and context', () => {
    const parts = buildPermissionPromptParts(commandRequest, 60_000);
    expect(parts.title).toBe('Allow exact command access?');
    expect(parts.bodyLines).toContain('Command:');
    expect(parts.bodyLines).toContain('npm test');
    expect(parts.bodyLines).toContain('```');
    expect(parts.contextLines[0]).toBe('Main Agent · agent chat');
    expect(parts.replyInMinutes).toBe(1);
  });

  it('adds a parent-conversation note for thread-routed requests', () => {
    const parts = buildPermissionPromptParts(
      { ...commandRequest, targetJid: 'tg:-100team', threadId: '42' },
      60_000,
    );
    expect(parts.contextLines).toContain(
      'Approval applies to the parent conversation.',
    );
  });

  it('surfaces account and risk for semantic capability grants', () => {
    const parts = buildPermissionPromptParts(
      {
        requestId: 'permission_1',
        sourceAgentFolder: 'main_agent',
        toolName: 'request_permission',
        toolInput: {
          capabilityId: 'acme.records.append',
          capabilityDisplayName: 'Acme records append',
          accountLabel: 'Acme tenant',
        },
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'capability:acme.records.append' }],
          },
        ],
        semanticCapabilityDefinitions: {
          'acme.records.append': {
            capabilityId: 'acme.records.append',
            displayName: 'Acme records append',
            category: 'acme',
            risk: 'write',
            credentialSource: 'configured_access',
            implementationBindings: [],
            preflight: { kind: 'none' },
          },
        },
      },
      60_000,
    );
    expect(parts.title).toBe('Allow Acme records append?');
    expect(parts.bodyLines).toContain('Risk: Write');
  });
});

describe('Telegram HTML rendering', () => {
  it('escapes only &, <, >', () => {
    expect(escapeTelegramHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('renders fenced regions as <pre> and escapes their content', () => {
    const html = renderBodyLinesHtml([
      'Command:',
      '```',
      'echo "<a> && </b>"',
      '```',
    ]);
    expect(html).toContain('<pre>echo "&lt;a&gt; &amp;&amp; &lt;/b&gt;"</pre>');
  });

  it('wraps the prompt title and never leaks raw code fences', () => {
    const html = renderPermissionPromptHtml(
      buildPermissionPromptParts(commandRequest, 60_000),
    );
    expect(html).toContain(
      `<b>${PERMISSION_GLYPH} Allow exact command access?</b>`,
    );
    expect(html).toContain('<pre>npm test</pre>');
    expect(html).not.toContain('```');
    expect(html).toContain('<i>Reply in 1m</i>');
  });

  it('hides secrets and keeps shell metacharacters HTML-safe', () => {
    const html = renderPermissionPromptHtml(
      buildPermissionPromptParts(
        {
          requestId: 'permission_1',
          sourceAgentFolder: 'main_agent',
          toolName: 'Bash',
          toolInput: {
            command:
              'curl https://x.test -H "Authorization: bearer abcdefghijklmnopqrstuvwxyz123456" > /tmp/out',
          },
        },
        60_000,
      ),
    );
    expect(html).toContain('hidden because it may contain sensitive values');
    expect(html).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    // A bare ">" from a redirect must be escaped so HTML parsing cannot break.
    expect(html).not.toMatch(/[^&]> \/tmp/);
  });

  it('renders a user question with a bold header and escaped options', () => {
    const html = renderUserQuestionPromptHtml({
      header: 'Deploy',
      question: 'Which DB <prod>?',
      multiSelect: true,
      options: [
        { label: 'Postgres', description: 'a & b' },
        { label: 'Mongo', description: 'docs' },
      ],
    });
    expect(html).toContain('<b>❓ Deploy</b>');
    expect(html).toContain('Which DB &lt;prod&gt;?');
    expect(html).toContain('<b>Postgres</b> — a &amp; b');
    expect(html).toContain('Select one or more, then tap Done.');
  });
});

describe('truncateSlackText', () => {
  it('never exceeds maxLen including the ellipsis (Slack header/button hard limit)', () => {
    const out = truncateSlackText('x'.repeat(200), 150);
    expect(out.length).toBe(150);
    expect(out.endsWith('...')).toBe(true);
  });

  it('returns short text unchanged', () => {
    expect(truncateSlackText('hi', 150)).toBe('hi');
  });

  it('does not throw or go negative when maxLen is smaller than the ellipsis', () => {
    expect(truncateSlackText('hello', 2)).toBe('...');
  });
});

describe('Slack permission blocks', () => {
  it('renders header, section, context, and divider', () => {
    const blocks = buildPermissionPromptContentBlocks(
      buildPermissionPromptParts(commandRequest, 60_000),
    ) as Array<Record<string, any>>;
    expect(blocks[0].type).toBe('header');
    expect(blocks[0].text.text).toBe(
      `${PERMISSION_GLYPH} Allow exact command access?`,
    );
    expect(blocks.some((b) => b.type === 'section')).toBe(true);
    const context = blocks.find((b) => b.type === 'context');
    expect(context?.elements[0].text).toContain('Main Agent · agent chat');
    expect(context?.elements[0].text).toContain('Reply in 1m');
    expect(blocks.at(-1)?.type).toBe('divider');
  });

  it('renders a receipt as a single muted context block', () => {
    const blocks = buildPermissionReceiptBlocks(
      '✅ Allowed once · Command (npm test)',
    ) as Array<Record<string, any>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('context');
    expect(blocks[0].elements[0].text).toBe(
      '✅ Allowed once · Command (npm test)',
    );
  });
});
