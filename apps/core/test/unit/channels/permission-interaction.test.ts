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

    expect(firstPersistentRule(request)).toBe('RunCommand(npm test *)');
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
      'Always allow',
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
    expect(decision.reason).toBe('approval option unavailable');
  });

  it('does not offer persistent approval for wildcard-scoped RunCommand suggestions', () => {
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

  it('offers persistent approval for SDK file tools via Gantry facades', () => {
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

    expect(firstPersistentRule(request)).toBe('FileRead');
    expect(permissionDecisionOptions(request)).toEqual([
      'allow_once',
      'allow_timed_grant',
      'allow_persistent_rule',
      'cancel',
    ]);
    expect(permissionButtonLabel('allow_timed_grant', request)).toBe(
      'Allow 5 min',
    );
  });

  it('keeps every button label short enough for narrow mobile screens', () => {
    const request = {
      ...requestWithSuggestions([
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'capability:acme.records.append' }],
        },
      ]),
    } satisfies PermissionApprovalRequest;
    const modes = [
      'allow_once',
      'allow_timed_grant',
      'allow_persistent_rule',
      'cancel',
    ] as const;
    for (const mode of modes) {
      const label = permissionButtonLabel(mode, request);
      expect(label.length).toBeLessThanOrEqual(20);
      // capability/delivery labels belong in the body, never on a button
      expect(label).not.toContain('acme');
      expect(label).not.toContain('capability');
    }
  });

  it('keeps scheduled job prompts aligned with the permission vocabulary', () => {
    const request = {
      ...requestWithSuggestions([]),
      jobId: 'job-1',
      jobName: 'Lead sync',
    };

    expect(permissionButtonLabel('allow_once', request)).toBe('Allow once');
    expect(permissionButtonLabel('allow_timed_grant', request)).toBe(
      'Allow 5 min',
    );
  });

  it('describes timed grants as eligible-tools/SDK-API-prompt approval decisions', () => {
    const decision = decisionForMode(
      {
        ...requestWithSuggestions([]),
        toolName: 'Read',
      },
      'allow_timed_grant',
      'user-1',
    );

    expect(decision).toEqual(
      expect.objectContaining({
        approved: true,
        mode: 'allow_timed_grant',
        decidedBy: 'user-1',
        reason: 'timed grant for eligible tools and SDK API prompts (5 min)',
        decisionClassification: 'user_temporary',
        timedGrantExpiresAtMs: expect.any(Number),
      }),
    );
  });

  it('rejects forged timed-grant decisions when the request did not offer them', () => {
    const decision = decisionForMode(
      {
        ...requestWithSuggestions([]),
        decisionOptions: ['allow_once', 'cancel'],
      },
      'allow_timed_grant',
      'user-1',
    );

    expect(decision).toEqual({
      approved: false,
      mode: 'cancel',
      decidedBy: 'user-1',
      reason: 'approval option unavailable',
      decisionClassification: 'user_reject',
    });
  });

  it('uses explicit request decision options instead of adding timed grants implicitly', () => {
    const request = {
      ...requestWithSuggestions([
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
        },
      ]),
      decisionOptions: ['allow_once', 'allow_persistent_rule', 'cancel'],
    } satisfies PermissionApprovalRequest;

    expect(permissionDecisionOptions(request)).toEqual([
      'allow_once',
      'allow_persistent_rule',
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
          capabilityId: 'acme.records.append',
          capabilityDisplayName: 'Acme records append',
          accountLabel: 'Acme tenant',
          can: 'Append records through reviewed Acme access.',
          cannot: 'Delete records, export secrets, or change account settings.',
        },
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'capability:acme.records.append' }],
          },
        ],
      },
      60_000,
    );

    expect(text.split('\n')[0]).toBe('Allow Acme records append?');
    expect(text).toContain('Account: Acme tenant');
    expect(text).toContain('Access: Acme records append');
    expect(text).toContain(
      'Allows: Append records through reviewed Acme access.',
    );
    expect(text).toContain(
      'Does not allow: Delete records, export secrets, or change account settings.',
    );
    expect(text).toContain('Capability: Acme Records Append');
    expect(text).not.toContain('capability:acme.records.append');
    expect(
      permissionButtonLabel(
        'allow_persistent_rule',
        requestWithSuggestions([
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'capability:acme.records.append' }],
          },
        ]),
      ),
    ).toBe('Always allow');
  });

  it('renders trusted skill action prompts with short mobile buttons', () => {
    const request = {
      requestId: 'permission_123',
      sourceAgentFolder: 'Main Agent',
      jobId: 'linkedin-job-1',
      toolName: 'Bash',
      toolInput: {
        command: 'python3 skills/linkedin-posting/post.py --file /tmp/post.md',
      },
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'capability:skill.linkedin-posting.publish' }],
        },
      ],
      semanticCapabilityDefinitions: {
        'skill.linkedin-posting.publish': {
          capabilityId: 'skill.linkedin-posting.publish',
          displayName: 'LinkedIn posting',
          category: 'linkedin-posting',
          risk: 'write',
          can: 'Publish a prepared LinkedIn post through the approved script.',
          cannot:
            'Read unrelated accounts or receive raw LinkedIn credentials.',
          credentialSource: 'skill_secret',
          implementationBindings: [
            {
              kind: 'tool_rule',
              rule: 'RunCommand(skills/linkedin-posting/post.py *)',
            },
          ],
          preflight: { kind: 'none' },
        },
      },
    } satisfies PermissionApprovalRequest;

    const text = formatPermissionPromptText(request, 60_000);

    expect(text.split('\n')[0]).toBe('Allow LinkedIn posting?');
    expect(text).toContain('From: scheduled job');
    expect(text).toContain('Agent: Main Agent');
    expect(text).toContain(
      'Allows: Publish a prepared LinkedIn post through the approved script.',
    );
    expect(permissionButtonLabel('allow_once', request)).toBe('Allow once');
    expect(permissionButtonLabel('allow_timed_grant', request)).toBe(
      'Allow 5 min',
    );
    expect(permissionButtonLabel('allow_persistent_rule', request)).toBe(
      'Always allow',
    );
    expect(permissionButtonLabel('cancel', request)).toBe('Cancel');

    const receipt = formatPermissionReceiptText('permission_123', request, {
      approved: true,
      mode: 'allow_persistent_rule',
      decidedBy: 'ravi',
    });
    expect(receipt).toContain(
      'Always allowed for Main Agent: LinkedIn posting',
    );
    expect(receipt).toContain('Details: LinkedIn posting');
  });

  it('renders the full provider-neutral semantic field set every channel shares', () => {
    const request = {
      requestId: 'permission_123',
      sourceAgentFolder: 'main_agent',
      targetJid: 'tg:-100team',
      threadId: '42',
      toolName: 'Bash',
      toolInput: { command: 'acme records append sheet A1' },
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
          can: 'Append records through reviewed Acme access.',
          cannot: 'Delete records or change account settings.',
          credentialSource: 'configured_access',
          implementationBindings: [
            { kind: 'tool_rule', rule: 'RunCommand(acme records append *)' },
          ],
          preflight: { kind: 'none' },
        },
      },
    } satisfies PermissionApprovalRequest;

    const text = formatPermissionPromptText(request, 60_000);

    expect(text.split('\n')[0]).toBe('Allow Acme records append?');
    expect(text).toContain('Agent: Main Agent');
    expect(text).toContain('From: agent chat');
    expect(text).toContain('Access: Acme records append');
    expect(text).toContain(
      'Allows: Append records through reviewed Acme access.',
    );
    expect(text).toContain(
      'Does not allow: Delete records or change account settings.',
    );
    expect(text).toContain('Risk: Write');
    expect(text).toContain('Scope:');
    expect(text).toContain(
      'Route: shown in this Telegram topic; approval applies to the parent conversation.',
    );
    // raw implementation details must stay out of primary copy
    expect(text).not.toContain('capability:acme.records.append');
    expect(text).not.toContain('RunCommand');
  });

  it('hides generated runtime skill paths in command prompts and receipts', () => {
    const request = {
      requestId: 'permission_123',
      sourceAgentFolder: 'Main Agent',
      toolName: 'Bash',
      toolInput: {
        command:
          'python3 /tmp/run/.llm-runtime/claude/skills/linkedin-posting/post.py --file /tmp/post.md',
      },
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [
            {
              toolName: 'RunCommand',
              ruleContent: 'skills/linkedin-posting/post.py *',
            },
          ],
        },
      ],
    } satisfies PermissionApprovalRequest;

    const text = formatPermissionPromptText(request, 60_000);
    expect(text).toContain(
      'Command: generated skill action command; runtime path hidden.',
    );
    expect(text).toContain('Action: skills/linkedin-posting/post.py');
    expect(text).not.toContain('.llm-runtime');

    const receipt = formatPermissionReceiptText('permission_123', request, {
      approved: true,
      mode: 'allow_once',
      decidedBy: 'ravi',
    });
    expect(receipt).toContain(
      'For: Selected skill action (skills/linkedin-posting/post.py)',
    );
    expect(receipt).not.toContain('.llm-runtime');
  });

  it('treats thread ids as prompt routing, not separate permission scope', () => {
    const request = {
      requestId: 'permission_123',
      sourceAgentFolder: 'Main Agent',
      targetJid: 'tg:-1003986348737',
      threadId: '2771',
      toolName: 'Bash',
      toolInput: {
        command: 'acme records append sheet-id A1:B2',
      },
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [
            {
              toolName: 'RunCommand',
              ruleContent: 'acme records append *',
            },
          ],
        },
      ],
    } satisfies PermissionApprovalRequest;

    const text = formatPermissionPromptText(request, 60_000);
    expect(text).toContain(
      'Route: shown in this Telegram topic; approval applies to the parent conversation.',
    );
    expect(text).toContain(
      'Scope: this request, a short 5-minute grant, or always allow future matching tool calls in the parent conversation.',
    );
    expect(text).not.toContain('Thread: 2771');

    const receipt = formatPermissionReceiptText('permission_123', request, {
      approved: true,
      mode: 'allow_timed_grant',
      decidedBy: 'ravi',
      timedGrantExpiresAtMs: Date.now() + 60_000,
    });
    expect(receipt).toContain(
      'Allowed for 5 minutes in parent conversation: exact command access',
    );
    expect(receipt).toContain(
      'Route: shown in this Telegram topic; approval applies to the parent conversation.',
    );
  });

  it('renders scoped RunCommand setup prompts as command rules even when capability metadata is present', () => {
    const text = formatPermissionPromptText(
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        toolName: 'request_permission',
        displayName: 'Permission: Acme records append using acme',
        title: 'Approve permission request',
        toolInput: {
          capabilityId: 'acme.records.append',
          capabilityDisplayName: 'Acme records append using acme',
          toolNames: ['Bash'],
          rule: '/usr/local/bin/acme records append *',
        },
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [
              {
                toolName: 'Bash',
                ruleContent: '/usr/local/bin/acme records append *',
              },
            ],
          },
        ],
      },
      60_000,
    );

    expect(text.split('\n')[0]).toBe('Allow exact command access?');
    expect(text).toContain(
      'Request: Permission: Acme records append using acme',
    );
    expect(text).toContain('Details: matching command access');
    expect(text).not.toContain('Always allow grants this capability');
    expect(text).not.toContain(
      'RunCommand(/usr/local/bin/acme records append *)',
    );
    expect(text).not.toContain('Configured Google access');
  });

  it('renders request_permission command fallbacks without implementation tool names', () => {
    const text = formatPermissionPromptText(
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        toolName: 'request_permission',
        displayName: 'RunCommand',
        description: 'Publish the LinkedIn post draft',
        decisionReason: 'Contains simple_expansion',
        toolInput: {
          command:
            'REQUESTS_CA_BUNDLE=$NODE_EXTRA_CA_CERTS /opt/homebrew/bin/python3 "$CLAUDE_PROJECT_DIR/skills/linkedin-posting/post.py" --file /tmp/post.md',
          description: 'Publish the LinkedIn post draft',
        },
      },
      60_000,
    );

    expect(text.split('\n')[0]).toBe('Allow exact command access?');
    expect(text).toContain('Request: Exact Command Access');
    expect(text).toContain('Reason: Contains shell expansion');
    expect(text).toContain('Details: Publish the LinkedIn post draft');
    expect(text).not.toContain(['Allow', 'RunCommand?'].join(' '));
    expect(text).not.toContain('"command"');
    expect(text).not.toContain('simple_expansion');
  });

  it('hides Bash commands with secrets in permission prompt previews', () => {
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

    expect(text).toContain(
      'Command: hidden because it may contain sensitive values.',
    );
    expect(text).toContain('Program: npm');
    expect(text).not.toContain('REDACTED');
    expect(text).not.toContain('sk-testsecretsecretsecretsecretsecretsecret');
    expect(text).not.toContain('Command:\n```');
  });

  it('keeps safe Bash command context when an opaque token is hidden', () => {
    const text = formatPermissionPromptText(
      {
        ...requestWithSuggestions([]),
        toolInput: {
          command:
            'curl https://api.example.com -H "Authorization: bearer abcdefghijklmnopqrstuvwxyz123456" --data ok',
        },
      },
      60_000,
    );

    expect(text).toContain(
      'Command: hidden because it may contain sensitive values.',
    );
    expect(text).toContain('Program: curl');
    expect(text).not.toContain('REDACTED');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });

  it('renders closest existing rule mismatch details in permission prompts', () => {
    const text = formatPermissionPromptText(
      {
        ...requestWithSuggestions([]),
        decisionReason:
          'Tool not on autonomous run allowlist: RunCommand. Bash leaf npm test did not match any scoped autonomous rule.',
        closestRule: {
          rule: 'RunCommand(npm run build)',
          reason:
            'Bash leaf npm test did not match any scoped autonomous rule.',
        },
        toolInput: { command: 'npm test' },
      },
      60_000,
    );

    expect(text).toContain('Closest existing access: matching command access');
    expect(text).toContain(
      '(did not match: command npm test did not match any scoped autonomous rule.)',
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
    expect(text).toContain('Scope: this request or a short 5-minute grant.');
    expect(text).not.toContain('future matching tool calls');
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
      "Allow exact command access?

      Agent: Main Agent
      From: agent chat

      Command:
      \`\`\`
      curl -sSf https://api.example.com/leads | jq '.[] | select(.score > 80)' > /tmp/leads.json
      \`\`\`
      Redirect: > /tmp/leads.json

      Details: matching command access, matching command access

      Scope: this request, a short 5-minute grant, or future matching tool calls.
      Safety: only matching future access is included; unrelated tools, secrets, and settings changes are not included.

      Reply within 5 minute(s)."
    `);
  });

  it('marks scheduled-job permission prompts without exposing job ids', () => {
    const text = formatPermissionPromptText(
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        jobId: 'knacklabs-lead-maintenance-controller-2026-05-15',
        jobName: 'KnackLabs Lead Maintenance Controller',
        toolName: 'Bash',
        toolInput: { command: 'npm run lead-generator' },
      },
      60_000,
    );

    expect(text).toContain(
      'From: scheduled job: KnackLabs Lead Maintenance Controller',
    );
    expect(text).toContain('Agent: Main Agent');
    expect(text).not.toContain(
      'knacklabs-lead-maintenance-controller-2026-05-15',
    );
  });

  it('marks interactive-agent permission prompts', () => {
    const text = formatPermissionPromptText(
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        toolName: 'Bash',
        toolInput: { command: 'git status --short' },
      },
      60_000,
    );

    expect(text).toContain('From: agent chat');
    expect(text).toContain('Agent: Main Agent');
    expect(text).not.toContain('From: scheduled job');
  });

  it('renders skill action capability prompts with the semantic display name', () => {
    const text = formatPermissionPromptText(
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        toolName: 'RunCommand',
        toolInput: {
          command: 'skills/linkedin-posting/publish --draft post.md',
        },
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'capability:skill.linkedin-posting.publish' }],
          },
        ],
        semanticCapabilityDefinitions: {
          'skill.linkedin-posting.publish': {
            capabilityId: 'skill.linkedin-posting.publish',
            displayName: 'LinkedIn posting',
            category: 'LinkedIn posting',
            risk: 'write',
            can: 'Publish posts through the selected LinkedIn posting skill.',
            cannot:
              'Use unrelated skills, credentials, settings, or broader commands.',
            credentialSource: 'skill_secret',
            implementationBindings: [
              {
                kind: 'tool_rule',
                rule: 'RunCommand(skills/linkedin-posting/publish *)',
              },
            ],
            preflight: { kind: 'none' },
            sandboxProfile: {
              network: 'required',
              filesystem: 'workspace_write',
            },
          },
        },
      },
      60_000,
    );

    expect(text).toContain('Allow LinkedIn posting?');
    expect(text).toContain('Risk: Write');
  });

  it('does not trust free-form labels for unknown skill action capabilities', () => {
    const request = {
      requestId: 'permission_123',
      sourceAgentFolder: 'main_agent',
      toolName: 'Bash',
      toolInput: {
        command: 'python3 skills/linkedin-posting/post.py --file /tmp/post.md',
        capabilityId: 'skill.linkedin-posting.publish',
        capabilityDisplayName: 'LinkedIn posting',
      },
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'capability:skill.linkedin-posting.publish' }],
        },
      ],
    } satisfies PermissionApprovalRequest;

    const text = formatPermissionPromptText(request, 60_000);

    expect(firstPersistentRule(request)).toBeUndefined();
    expect(permissionDecisionOptions(request)).toEqual([
      'allow_once',
      'allow_timed_grant',
      'cancel',
    ]);
    expect(text.split('\n')[0]).toBe('Allow exact command access?');
    expect(text).not.toContain('Allow LinkedIn posting?');
    expect(text).not.toContain('future matching runs');
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

  it('renders unknown non-command input as pretty JSON with head and tail content', () => {
    const longValue = `lookup ${'x'.repeat(650)} tail`;
    const text = formatPermissionPromptText(
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        toolName: 'mcp__thirdparty__unknown',
        toolInput: { query: longValue, nested: { ok: true } },
      },
      60_000,
    );

    expect(text).toContain('```json');
    expect(text).toContain('lookup ');
    expect(text).toContain('tail');
    expect(text).toContain('…');
  });

  it('renders any command-shaped permission input without a JSON dump', () => {
    const text = formatPermissionPromptText(
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        toolName: 'mcp__thirdparty__run',
        toolInput: { command: 'acme publish draft-123' },
      },
      60_000,
    );

    expect(text.split('\n')[0]).toBe('Allow exact command access?');
    expect(text).toContain('Command:\n```');
    expect(text).toContain('acme publish draft-123');
    expect(text).not.toContain('```json');
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

    expect(receipt).toContain('Allowed once: exact command access');
    expect(receipt).toContain('For: Command (git status --short)');
    expect(receipt).toContain('From: agent chat');
    expect(receipt).toContain('Agent: Main Agent');
    expect(receipt).not.toContain('Request ID');
    expect(receipt).not.toContain('perm-abc-123');
  });

  it('describes timed receipts with the trigger reason and no internal request id', () => {
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
        mode: 'allow_timed_grant',
        decidedBy: 'ravi',
        timedGrantExpiresAtMs: Date.parse('2026-05-15T12:05:00Z'),
      },
    );

    expect(receipt).toContain('Allowed for 5 minutes: exact command access');
    expect(receipt).toContain('Until:');
    expect(receipt).toContain('For: Command (git status --short)');
    expect(receipt).toContain('From: agent chat');
    expect(receipt).toContain('Agent: Main Agent');
    expect(receipt).not.toContain('eligible tools and SDK API/network prompts');
    expect(receipt).not.toContain('Request ID');
    expect(receipt).not.toContain('perm-abc-123');
  });

  it('clarifies thread-scoped timed and parent-conversation persistent grants from a routed thread', () => {
    const request = {
      ...requestWithSuggestions([
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
        },
      ]),
      threadId: 'topic-7',
      toolInput: { command: 'npm test' },
    } satisfies PermissionApprovalRequest;

    const prompt = formatPermissionPromptText(request, 60_000);
    expect(prompt).toContain(
      'Scope: this request, a short 5-minute grant, or always allow future matching tool calls in the parent conversation.',
    );

    const timedReceipt = formatPermissionReceiptText('perm-abc-123', request, {
      approved: true,
      mode: 'allow_timed_grant',
      timedGrantExpiresAtMs: Date.parse('2026-05-15T12:05:00Z'),
    });
    expect(timedReceipt).toContain(
      'Allowed for 5 minutes in parent conversation: exact command access',
    );

    const persistentReceipt = formatPermissionReceiptText(
      'perm-abc-123',
      request,
      {
        approved: true,
        mode: 'allow_persistent_rule',
      },
    );
    expect(persistentReceipt).toContain(
      'Always allowed for Kai Group: exact command access',
    );
    expect(persistentReceipt).toContain(
      'approval applies to the parent conversation',
    );
  });

  it('marks scheduled-job receipts without exposing job ids', () => {
    const receipt = formatPermissionReceiptText(
      'perm-abc-123',
      {
        requestId: 'perm-abc-123',
        sourceAgentFolder: 'main_agent',
        jobId: 'knacklabs-lead-maintenance-controller-2026-05-15',
        toolName: 'Bash',
        toolInput: { command: 'npm run lead-generator' },
      },
      {
        approved: true,
        mode: 'allow_once',
        decidedBy: 'ravi',
      },
    );

    expect(receipt).toContain('Allowed once: exact command access');
    expect(receipt).toContain('From: scheduled job');
    expect(receipt).toContain('Agent: Main Agent');
    expect(receipt).not.toContain(
      'knacklabs-lead-maintenance-controller-2026-05-15',
    );
    expect(receipt).not.toContain('perm-abc-123');
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

    expect(receipt).toContain(
      'Always allowed for Kai Group: exact command access',
    );
    expect(receipt).toContain('Details: matching command access');
    expect(receipt).toContain('Browser');
    expect(receipt).not.toContain('RunCommand(curl https://api.example.com/*)');
    expect(receipt).not.toContain('RunCommand(jq *)');
    expect(receipt).toContain('Revoke from Agent Access.');
    expect(receipt).toContain(
      'For: Command (curl https://api.example.com/leads > /tmp/out)',
    );
    expect(receipt).not.toContain('Request ID');
    expect(receipt).not.toContain('perm-abc-123');
  });

  it('omits sensitive details instead of showing redaction markers in accepted receipts', () => {
    const receipt = formatPermissionReceiptText(
      'perm-abc-123',
      {
        requestId: 'perm-abc-123',
        sourceAgentFolder: 'main_agent',
        toolName: 'Bash',
        toolInput: {
          command:
            'curl https://api.example.com -H "Authorization: bearer abcdefghijklmnopqrstuvwxyz123456"',
        },
      },
      {
        approved: true,
        mode: 'allow_once',
        decidedBy: 'ravi',
      },
    );

    expect(receipt).toContain('Allowed once');
    expect(receipt).toContain('For: Command');
    expect(receipt).not.toContain('REDACTED');
    expect(receipt).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(receipt).not.toContain('Request ID');
    expect(receipt).not.toContain('perm-abc-123');
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
    expect(text).toContain('Reason: Sensitive detail hidden.');
    expect(text).toContain('Details: Sensitive detail hidden.');
    expect(text).toContain('"cookie": "[hidden]"');
    expect(text).toContain('"safe": "visible"');
    expect(text).toContain('"__omitted_keys": "more"');
    expect(text).not.toContain('REDACTED');
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
