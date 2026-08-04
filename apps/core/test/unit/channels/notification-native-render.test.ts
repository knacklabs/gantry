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
  buildPermissionFullViewModalBlocks,
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
    expect(parts.title).toBe('Allow Main Agent to use exact command access?');
    expect(parts.bodyLines).toEqual(['Runs: npm']);
    expect(parts.contextLines[0]).toBe('Agent: Main Agent');
    expect(parts.contextLines[1]).toBe('Context: agent chat');
    expect(parts.contextLines).toContain(
      'The agent cannot approve this itself.',
    );
    expect(parts.replyInMinutes).toBe(1);
    expect(parts.fullView).toMatchObject({
      label: 'View full command',
      content: 'npm test',
    });
  });

  it('keeps full command out of Telegram prompt unless full view is requested', () => {
    const parts = buildPermissionPromptParts(
      {
        ...commandRequest,
        toolInput: {
          description: 'Run the test suite',
          command: 'npm test -- --runInBand',
        },
      },
      60_000,
    );
    const collapsed = renderPermissionPromptHtml(parts);
    expect(collapsed).toContain('Run the test suite');
    expect(collapsed).not.toContain('npm test -- --runInBand');

    const expanded = renderPermissionPromptHtml(parts, {
      includeFullView: true,
    });
    expect(expanded).toContain('<b>View full command</b>');
    expect(expanded).toContain(
      '<blockquote expandable>npm test -- --runInBand</blockquote>',
    );
  });

  it('builds a Slack full-view modal without truncating payload text', () => {
    const blocks = buildPermissionFullViewModalBlocks({
      label: 'View diff',
      title: 'Full diff',
      filename: 'permission-diff.diff',
      content: `-${'old\n'.repeat(1200)}+new`,
    });
    const rendered = blocks
      .map((block) => ((block as any).text?.text as string | undefined) || '')
      .join('');
    expect(rendered).toContain('+new');
    expect(rendered).not.toContain('...');
  });

  it('keeps settings YAML in full view instead of the inline body', () => {
    const yaml = `agents:\n  main_agent:\n    name: Gantry\n${'x'.repeat(1200)}`;
    const parts = buildPermissionPromptParts(
      {
        requestId: 'settings-1',
        sourceAgentFolder: 'main_agent',
        toolName: 'request_settings_update',
        toolInput: {
          expectedRevision: 'rev-1',
          agentCount: 1,
          replacementYaml: yaml,
          diffSummary: ['+ 3:     name: Gantry'],
        },
      },
      60_000,
    );

    expect(parts.bodyLines.join('\n')).not.toContain(yaml);
    expect(parts.fullView).toMatchObject({
      label: 'View settings change',
      filename: 'settings-change.yaml',
      content: yaml,
    });
  });

  it('omits the body for a tool that takes no arguments (no empty Input block)', () => {
    const parts = buildPermissionPromptParts(
      {
        requestId: 'permission_1',
        sourceAgentFolder: 'main_agent',
        toolName: 'mcp__gantry__guided_action_preview',
        toolInput: {},
      },
      60_000,
    );
    expect(parts.bodyLines).toEqual([]);
    const html = renderPermissionPromptHtml(parts);
    expect(html).not.toContain('Input:');
    expect(html).not.toContain('{}');
  });

  it('renders admin request tools as clean fields, not a raw JSON dump', () => {
    const skill = buildPermissionPromptParts(
      {
        requestId: 'r',
        sourceAgentFolder: 'main_agent',
        toolName: 'request_skill_install',
        displayName: 'Skill: linkedin-posting',
        toolInput: {
          skillId: 'skill:564c',
          name: 'linkedin-posting',
          description: 'Publish posts to LinkedIn',
          requiredEnvVars: ['LINKEDIN_ACCESS_TOKEN'],
          files: [
            {
              path: 'SKILL.md',
              sizeBytes: 1200,
              contentHash: 'sha256:abc123',
            },
            { path: 'post.py', sizeBytes: 3400, contentHash: 'sha256:def456' },
          ],
          totalSizeBytes: 4600,
          skillMarkdownPreview: {
            path: '/tmp/staged/SKILL.md',
            content:
              '# LinkedIn Posting\n\nUse this skill to publish approved LinkedIn posts.',
            truncated: false,
          },
        },
      },
      60_000,
    );
    expect(skill.bodyLines).toContain('Description: Publish posts to LinkedIn');
    expect(skill.bodyLines).toContain('Files: 2 (4.5 KB)');
    expect(skill.bodyLines).toContain('Review files:');
    expect(skill.bodyLines).toContain('- SKILL.md (1.2 KB, sha256:abc123)');
    expect(skill.bodyLines).toContain(
      'Credentials: required before some skill actions can run; add them in Credential Center.',
    );
    expect(skill.bodyLines.join('\n')).not.toContain('LINKEDIN_ACCESS_TOKEN');
    expect(skill.bodyLines).toContain('SKILL.md preview:');
    expect(skill.bodyLines).toContain(
      '# LinkedIn Posting\n\nUse this skill to publish approved LinkedIn posts.',
    );
    // No raw JSON / internal ids leaked.
    expect(skill.bodyLines.join('\n')).not.toContain('skillId');
    expect(skill.bodyLines.join('\n')).not.toContain('/tmp/staged');
    expect(skill.bodyLines.join('\n')).not.toContain('```json');

    const mcp = buildPermissionPromptParts(
      {
        requestId: 'r',
        sourceAgentFolder: 'main_agent',
        toolName: 'request_mcp_server',
        displayName: 'MCP server: linear',
        toolInput: {
          name: 'linear',
          transport: 'stdio_template',
          sandboxProfileId: 'sp-1',
          origin: 'npx -y @linear/mcp',
          requestedToolPatterns: ['linear_*'],
          credentialNeeds: ['LINEAR_API_KEY'],
          networkHosts: ['api.linear.app:443'],
        },
      },
      60_000,
    );
    expect(mcp.bodyLines).toContain('Transport: stdio_template');
    expect(mcp.bodyLines).toContain('Install: npx -y @linear/mcp');
    expect(mcp.bodyLines).toContain('Needs credentials: LINEAR_API_KEY');
    expect(mcp.bodyLines).toContain('Network: api.linear.app:443');
    expect(mcp.bodyLines.join('\n')).not.toContain('sandboxProfileId');
  });

  it('redacts only sensitive values inside skill review previews', () => {
    const parts = buildPermissionPromptParts(
      {
        requestId: 'r',
        sourceAgentFolder: 'main_agent',
        toolName: 'request_skill_proposal',
        displayName: 'Skill: linkedin-posting',
        toolInput: {
          name: 'linkedin-posting',
          description: 'Publish approved LinkedIn posts',
          files: [
            {
              path: 'SKILL.md',
              sizeBytes: 220,
              contentHash: 'sha256:abc123',
            },
          ],
          skillMarkdownPreview: {
            path: 'SKILL.md',
            content: [
              '# LinkedIn Posting',
              '',
              'Use this skill to publish approved drafts.',
              'access_token: abcdefghijklmnop123456',
              'Network: api.linkedin.com:443',
            ].join('\n'),
            truncated: false,
          },
        },
      },
      60_000,
    );
    const body = parts.bodyLines.join('\n');

    expect(body).toContain('# LinkedIn Posting');
    expect(body).toContain('Use this skill to publish approved drafts.');
    expect(body).toContain('access_token=[REDACTED_SECRET]');
    expect(body).toContain('Network: api.linkedin.com:443');
    expect(body).not.toContain('Sensitive detail hidden.');
    expect(body).not.toContain('abcdefghijklmnop123456');
  });

  it('splits long Slack permission bodies instead of truncating review text', () => {
    const blocks = buildPermissionPromptContentBlocks({
      title: 'Allow profile update?',
      bodyLines: ['Full content:', '```markdown', 'x'.repeat(3500), '```'],
      contextLines: ['Agent: Main Agent'],
      replyInMinutes: 1,
    });

    const sectionTexts = blocks
      .filter((block) => block.type === 'section')
      .map((block) => (block.text as { text: string }).text);
    expect(sectionTexts).toHaveLength(3);
    expect(sectionTexts[0]).toBe('Full content:');
    expect(
      sectionTexts
        .slice(1)
        .map((text) => text.replace(/^```markdown\n/, '').replace(/\n```$/, ''))
        .join(''),
    ).toBe('x'.repeat(3500));
    for (const text of sectionTexts) {
      expect(text.length).toBeLessThanOrEqual(3000);
      expect(text).not.toContain('...');
    }
    expect(sectionTexts[1]?.startsWith('```markdown\n')).toBe(true);
    expect(sectionTexts[1]?.endsWith('\n```')).toBe(true);
    expect(sectionTexts[2]?.startsWith('```markdown\n')).toBe(true);
    expect(sectionTexts[2]?.endsWith('\n```')).toBe(true);
  });

  it('drops internal plumbing ids from the generic fallback for unknown tools', () => {
    const parts = buildPermissionPromptParts(
      {
        requestId: 'permission_1',
        sourceAgentFolder: 'main_agent',
        toolName: 'mcp__third_party__do_thing',
        toolInput: {
          label: 'deploy',
          chatJid: 'tg:-100team',
          ipcDir: '/var/run/gantry/ipc',
          runHandle: 'rh-9',
          sandboxProfileId: 'sp-1',
          agentId: 'agent:team',
        },
      },
      60_000,
    );
    const body = parts.bodyLines.join('\n');
    expect(body).toContain('Label: deploy');
    expect(body).not.toContain('tg:-100team');
    expect(body).not.toContain('/var/run/gantry/ipc');
    expect(body).not.toContain('rh-9');
    expect(body).not.toContain('sp-1');
    expect(body).not.toContain('agent:team');
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
    expect(parts.title).toBe('Allow Main Agent to use Acme records append?');
    expect(parts.bodyLines).toContain('Risk: Write');
  });
});

describe('Telegram HTML rendering', () => {
  it('escapes only &, <, >', () => {
    expect(escapeTelegramHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('converts inline `code` spans to <code> and escapes their content', () => {
    expect(renderBodyLinesHtml(['Run `npm <test> & lint` now'])).toBe(
      'Run <code>npm &lt;test&gt; &amp; lint</code> now',
    );
    // Backticks that would inject a tag are neutralized.
    expect(renderBodyLinesHtml(['`</code><b>x`'])).toBe(
      '<code>&lt;/code&gt;&lt;b&gt;x</code>',
    );
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

  it('renders markdown fences used by profile review evidence as <pre>', () => {
    const html = renderBodyLinesHtml([
      'Full content:',
      '```markdown',
      '# Agent\nUse <safe> text.',
      '```',
    ]);
    expect(html).toContain('<pre># Agent\nUse &lt;safe&gt; text.</pre>');
    expect(html).not.toContain('```markdown');
  });

  it('wraps the prompt title and never leaks raw code fences', () => {
    const html = renderPermissionPromptHtml(
      buildPermissionPromptParts(commandRequest, 60_000),
    );
    expect(html).toContain(
      `<b>${PERMISSION_GLYPH} Allow Main Agent to use exact command access?</b>`,
    );
    expect(html).toContain('Runs: npm');
    expect(html).not.toContain('<pre>npm test</pre>');
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
      `${PERMISSION_GLYPH} Allow Main Agent to use exact command access?`,
    );
    expect(blocks.some((b) => b.type === 'section')).toBe(true);
    const context = blocks.find((b) => b.type === 'context');
    expect(context?.elements[0].text).toContain('Agent: Main Agent');
    expect(context?.elements[0].text).toContain('Context: agent chat');
    expect(context?.elements[0].text).toContain('Reply in 1m');
    expect(blocks.at(-1)?.type).toBe('divider');
  });

  it('renders a receipt as a single muted context block', () => {
    const blocks = buildPermissionReceiptBlocks(
      'Allowed once: Command (npm test). The agent will continue this request.',
    ) as Array<Record<string, any>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('context');
    expect(blocks[0].elements[0].text).toBe(
      'Allowed once: Command (npm test). The agent will continue this request.',
    );
  });
});
