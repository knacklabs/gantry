import { describe, expect, it } from 'vitest';

import {
  decisionForMode,
  firstPersistentRule,
  formatPermissionPromptText,
  formatPermissionReceiptText,
  persistentRules,
  permissionDecisionOptions,
  permissionButtonLabel,
} from '@core/channels/permission-interaction.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';

function requestWithSuggestions(
  suggestions: PermissionApprovalRequest['suggestions'],
): PermissionApprovalRequest {
  return {
    requestId: 'permission_123',
    sourceAgentFolder: 'kai_group',
    toolName: 'Bash',
    suggestions,
  };
}

describe('permission interaction', () => {
  it('allows persistent approval only when one displayed rule maps to one update', () => {
    const request = requestWithSuggestions([
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
      },
    ]);

    expect(firstPersistentRule(request)).toBe('Bash(npm test *)');
    expect(permissionDecisionOptions(request)).toContain(
      'allow_persistent_rule',
    );
    expect(
      decisionForMode(request, 'allow_persistent_rule').updatedPermissions,
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
      },
    ]);
  });

  it('allows persistent approval when one displayed update contains multiple rules', () => {
    const request = requestWithSuggestions([
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [
          { toolName: 'Bash', ruleContent: 'git status' },
          { toolName: 'Bash', ruleContent: 'head' },
        ],
      },
    ]);

    expect(permissionDecisionOptions(request)).toContain(
      'allow_persistent_rule',
    );
    expect(permissionButtonLabel('allow_persistent_rule', request)).toBe(
      'Always allow 2 rules',
    );
    expect(
      decisionForMode(request, 'allow_persistent_rule').updatedPermissions,
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [
          { toolName: 'Bash', ruleContent: 'git status' },
          { toolName: 'Bash', ruleContent: 'head' },
        ],
      },
    ]);
  });

  it('does not offer persistent approval when hidden extra rules are present', () => {
    const request = requestWithSuggestions([
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
      },
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: 'Bash', ruleContent: '*' }],
      },
    ]);

    expect(firstPersistentRule(request)).toBeUndefined();
    expect(permissionDecisionOptions(request)).toEqual([
      'allow_once',
      'allow_timed_grant',
      'cancel',
    ]);
    const decision = decisionForMode(request, 'allow_persistent_rule');
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('persistent rule unavailable');
  });

  it('does not offer persistent approval for wildcard-scoped Bash suggestions', () => {
    const request = requestWithSuggestions([
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: 'Bash', ruleContent: '*' }],
      },
    ]);

    expect(firstPersistentRule(request)).toBeUndefined();
    expect(permissionDecisionOptions(request)).toEqual([
      'allow_once',
      'allow_timed_grant',
      'cancel',
    ]);
  });

  it('does not offer persistent approval for exact non-Bash SDK grants', () => {
    const request = {
      ...requestWithSuggestions([
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Read' }],
        },
      ]),
      toolName: 'Read',
    };

    expect(firstPersistentRule(request)).toBeUndefined();
    expect(permissionDecisionOptions(request)).toEqual([
      'allow_once',
      'allow_timed_grant',
      'cancel',
    ]);
  });

  it('renders semantic capability prompts before raw implementation details', () => {
    const text = formatPermissionPromptText(
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        toolName: 'request_permission',
        toolInput: {
          capabilityId: 'google.sheets.write',
          capabilityDisplayName: 'Google Sheets write',
          accountLabel: 'ravi@example.com',
          can: 'Update spreadsheet values.',
          cannot: 'Change sharing or read Gmail.',
        },
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'capability:google.sheets.write' }],
          },
        ],
      },
      60_000,
    );

    expect(text.split('\n')[0]).toBe('Allow Google Sheets write?');
    expect(text).toContain('Capability: capability:google.sheets.write');
    expect(text).toContain('Risk: write');
    expect(text).toContain('Account: OneCLI Google account');
    expect(text).toContain(
      'Allows: Read and update spreadsheet values through the configured brokered Google account.',
    );
    expect(text).toContain(
      'Does not allow: Change sharing, manage Drive files outside Sheets operations, access Gmail, or receive raw OAuth tokens.',
    );
    expect(text).toContain('Raw rule: capability:google.sheets.write');
    expect(text).not.toContain('ravi@example.com');
    expect(text).not.toContain('Change sharing or read Gmail.');
    expect(text.indexOf('Allow Google Sheets write?')).toBeLessThan(
      text.indexOf('Raw rule: capability:google.sheets.write'),
    );
    expect(
      permissionButtonLabel(
        'allow_persistent_rule',
        requestWithSuggestions([
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'capability:google.sheets.write' }],
          },
        ]),
      ),
    ).toBe('Always allow for this agent');
  });

  it('redacts Bash secrets in permission prompt previews', () => {
    const text = formatPermissionPromptText(
      {
        ...requestWithSuggestions([]),
        toolInput: {
          command:
            'OPENAI_API_KEY=sk-testsecretsecretsecretsecretsecretsecret npm test',
        },
      },
      60_000,
    );

    expect(text).toContain('OPENAI_API_KEY=[REDACTED_SECRET]');
    expect(text).not.toContain('sk-testsecretsecretsecretsecretsecretsecret');
    expect(text).toContain('Command:\n```');
  });

  it('renders closest existing rule mismatch details in permission prompts', () => {
    const text = formatPermissionPromptText(
      {
        ...requestWithSuggestions([]),
        decisionReason:
          'Tool not on autonomous job allowlist: Bash. Bash leaf npm test did not match any scoped autonomous rule.',
        closestRule: {
          rule: 'Bash(npm run build)',
          reason:
            'Bash leaf npm test did not match any scoped autonomous rule.',
        },
        toolInput: { command: 'npm test' },
      },
      60_000,
    );

    expect(text).toContain(
      'Closest existing rule: scoped Bash rule [sha256:ba74d93e8fec4d05] (did not match: Bash leaf npm test did not match any scoped autonomous rule.)',
    );
  });

  it('shows destructive Bash redirect targets without offering persistence', () => {
    const text = formatPermissionPromptText(
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        toolName: 'Bash',
        toolInput: { command: 'cat secrets.env > /etc/passwd' },
        suggestions: [],
      },
      60_000,
    );

    expect(text).toContain('Redirect: > /etc/passwd');
    expect(text).toContain(
      'What this changes: Allow once applies only to this tool call.',
    );
    expect(text).not.toContain('Always allow applies');
  });

  it('renders a structured Bash prompt with persistent rules', () => {
    const text = formatPermissionPromptText(
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        toolName: 'Bash',
        toolInput: {
          command:
            "curl -sSf https://api.example.com/leads | jq '.[] | select(.score > 80)' > /tmp/leads.json",
        },
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [
              {
                toolName: 'Bash',
                ruleContent: 'curl https://api.example.com/*',
              },
              { toolName: 'Bash', ruleContent: 'jq *' },
            ],
          },
        ],
      },
      300_000,
    );

    expect(text).toMatchInlineSnapshot(`
      "Bash request

      Tool: Bash
      Agent: main_agent

      Command:
      \`\`\`
      curl -sSf https://api.example.com/leads | jq '.[] | select(.score > 80)' > /tmp/leads.json
      \`\`\`
      Redirect: > /tmp/leads.json

      Approving persistent will grant:
        • Bash(curl https://api.example.com/*)
        • Bash(jq *)

      What this changes: Allow once applies only to this tool call.
      Always allow applies these rules to matching future tool calls: Bash(curl https://api.example.com/*), Bash(jq *)
      What this does not allow: unrelated tools, secrets, settings edits, or broader access outside the rule.

      Reply within 5 minute(s)."
    `);
  });

  it('renders typed tool input families without JSON dumps', () => {
    const edit = formatPermissionPromptText(
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        toolName: 'Edit',
        toolInput: {
          file_path: '/repo/app.ts',
          old_string: 'const unsafe = true;',
          new_string: 'const unsafe = false;',
        },
      },
      60_000,
    );
    expect(edit).toContain('File: /repo/app.ts');
    expect(edit).toContain(
      '```diff\n-const unsafe = true;\n+const unsafe = false;\n```',
    );

    const read = formatPermissionPromptText(
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        toolName: 'Read',
        toolInput: { file_path: '/repo/README.md' },
      },
      60_000,
    );
    expect(read).toContain('Path: /repo/README.md');
    expect(read).not.toContain('```json');

    const webFetch = formatPermissionPromptText(
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        toolName: 'WebFetch',
        toolInput: {
          url: 'https://example.com/docs',
          prompt: 'Summarize the setup section.',
        },
      },
      60_000,
    );
    expect(webFetch).toContain('URL: https://example.com/docs');
    expect(webFetch).toContain('Prompt: Summarize the setup section.');
  });

  it('renders unknown MCP input as pretty JSON with head and tail content', () => {
    const longValue = `curl ${'x'.repeat(650)} > /tmp/out`;
    const text = formatPermissionPromptText(
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        toolName: 'mcp__thirdparty__unknown',
        toolInput: { command: longValue, nested: { ok: true } },
      },
      60_000,
    );

    expect(text).toContain('```json');
    expect(text).toContain('curl ');
    expect(text).toContain('> /tmp/out');
    expect(text).toContain('…');
  });

  it('echoes the approved action in once receipts', () => {
    const receipt = formatPermissionReceiptText(
      'perm-abc-123',
      {
        requestId: 'perm-abc-123',
        sourceAgentFolder: 'main_agent',
        toolName: 'Bash',
        toolInput: { command: 'git status --short' },
      },
      {
        approved: true,
        mode: 'allow_once',
        decidedBy: 'ravi',
      },
    );

    expect(receipt).toContain('Allowed once');
    expect(receipt).toContain('For tool: Bash (git status --short)');
    expect(receipt).toContain('Request ID: `perm-abc-123`');
  });

  it('lists persistent rules and revoke hint in receipts', () => {
    const receipt = formatPermissionReceiptText(
      'perm-abc-123',
      {
        ...requestWithSuggestions([
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [
              {
                toolName: 'Bash',
                ruleContent: 'curl https://api.example.com/*',
              },
              { toolName: 'Bash', ruleContent: 'jq *' },
              { toolName: 'Browser' },
            ],
          },
        ]),
        toolInput: { command: 'curl https://api.example.com/leads > /tmp/out' },
      },
      {
        approved: true,
        mode: 'allow_persistent_rule',
        decidedBy: 'ravi',
      },
    );

    expect(receipt).toContain('  • Bash(curl https://api.example.com/*)');
    expect(receipt).toContain('  • Bash(jq *)');
    expect(receipt).toContain('  • Browser');
    expect(receipt).toContain(
      'Applying persistent grants now; final success or failure will be reported separately.',
    );
    expect(receipt).toContain(
      'If applied, revoke with: /permissions remove <rule>',
    );
    expect(receipt).toContain(
      'For tool: Bash (curl https://api.example.com/leads > /tmp/out)',
    );
  });

  it('bounds and redacts prompt-visible free text and unknown input previews', () => {
    const wideInput: Record<string, unknown> = {
      cookie: 'session-cookie-value',
      safe: 'visible',
      huge: 'z'.repeat(10_000),
    };
    for (let index = 0; index < 100; index += 1) {
      wideInput[`extra_${index}`] = `value_${index}`;
    }
    const text = formatPermissionPromptText(
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        toolName: 'mcp__thirdparty__unknown',
        decisionReason: `needs token=abc12345678901234567890 ${'x'.repeat(4_000)}`,
        description: `password: top-secret-value ${'y'.repeat(4_000)}`,
        toolInput: wideInput,
      },
      60_000,
    );

    expect(text.length).toBeLessThanOrEqual(2_800);
    expect(text).toContain('Reason: [REDACTED_POTENTIALLY_SENSITIVE]');
    expect(text).toContain('password=[REDACTED_SECRET]');
    expect(text).toContain('"cookie": "[REDACTED_SECRET]"');
    expect(text).toContain('"safe": "visible"');
    expect(text).toContain('"__omitted_keys": "more"');
    expect(text).not.toContain('session-cookie-value');
    expect(text).not.toContain('top-secret-value');
    expect(text).not.toContain('extra_99');
  });

  it('rejects oversized persistent suggestion rule sets', () => {
    const rules = Array.from({ length: 100 }, (_, index) => ({
      toolName: 'Bash',
      ruleContent: index === 0 ? 'git status' : `echo rule-${index}`,
    }));
    const request = {
      requestId: 'permission_123',
      sourceAgentFolder: 'main_agent',
      toolName: 'Bash',
      suggestions: [
        {
          type: 'addRules' as const,
          behavior: 'allow' as const,
          rules,
        },
      ],
    };

    expect(persistentRules(request)).toEqual([]);
    expect(permissionDecisionOptions(request)).toEqual([
      'allow_once',
      'allow_timed_grant',
      'cancel',
    ]);
  });

  it('preserves long command head and tail in prompt and receipt summaries', () => {
    const command = `curl https://api.example.com/${'a'.repeat(1_300)} > /tmp/out`;
    const text = formatPermissionPromptText(
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        toolName: 'Bash',
        toolInput: { command },
      },
      60_000,
    );
    const receipt = formatPermissionReceiptText(
      'permission_123',
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        toolName: 'Bash',
        toolInput: { command },
      },
      { approved: true, mode: 'allow_once' },
    );

    expect(text).toContain('curl https://api.example.com/');
    expect(text).toContain('> /tmp/out');
    expect(receipt).toContain('curl https://api.example.com/');
    expect(receipt).toContain('> /tmp/out');
  });
});
