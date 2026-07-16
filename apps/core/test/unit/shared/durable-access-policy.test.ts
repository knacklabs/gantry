import { describe, expect, it } from 'vitest';

import {
  DURABLE_ACCESS_RULE_REJECTION_REASON,
  formatDurableAccessRulesForUser,
  isDurableAccessRuleAllowed,
  validateDurableAccessRule,
} from '@core/shared/durable-access-policy.js';
import type { SemanticCapabilityDefinition } from '@core/shared/semantic-capabilities.js';

const skillActionDefinition: SemanticCapabilityDefinition = {
  capabilityId: 'skill.linkedin-posting.publish',
  displayName: 'LinkedIn posting',
  category: 'linkedin-posting',
  risk: 'write',
  can: 'Publish posts through the selected LinkedIn posting skill.',
  cannot: 'Use unrelated skills, credentials, settings, or broader commands.',
  credentialSource: 'skill_secret',
  implementationBindings: [
    {
      kind: 'tool_rule',
      rule: 'RunCommand(skills/linkedin-posting/post.py *)',
    },
  ],
  preflight: { kind: 'none' },
};

const localCliDefinition: SemanticCapabilityDefinition = {
  capabilityId: 'acme.records.append',
  displayName: 'Acme records append',
  category: 'Acme',
  risk: 'write',
  can: 'Append records through the reviewed CLI binding.',
  cannot: 'Read unrelated records or expose raw credentials.',
  credentialSource: 'local_cli',
  implementationBindings: [
    {
      kind: 'local_cli',
      executablePath: '/usr/local/bin/acme',
      executableVersion: '1.0.0',
      executableHash: 'sha256:abc123',
      commandTemplates: ['/usr/local/bin/acme records append *'],
    },
  ],
};

describe('durable access policy', () => {
  it('allows exact Gantry facade tools as durable access rules', () => {
    for (const toolName of [
      'WebSearch',
      'WebRead',
      'FileSearch',
      'FileRead',
      'FileEdit',
      'FileWrite',
      'AgentDelegation',
    ]) {
      expect(validateDurableAccessRule(toolName)).toEqual({
        ok: true,
      });
      expect(isDurableAccessRuleAllowed(toolName)).toBe(true);
    }
  });

  it('allows canonical Browser and exact Gantry admin tools', () => {
    expect(validateDurableAccessRule('Browser')).toEqual({ ok: true });
    expect(
      validateDurableAccessRule('mcp__gantry__settings_desired_state'),
    ).toEqual({ ok: true });
  });

  it('rejects exact third-party MCP tools', () => {
    expect(validateDurableAccessRule('mcp__github__get_issue')).toEqual({
      ok: false,
      reason: DURABLE_ACCESS_RULE_REJECTION_REASON,
    });
  });

  it('rejects non-admin Gantry MCP tools as durable access rules', () => {
    expect(
      validateDurableAccessRule('mcp__gantry__send_message'),
    ).toMatchObject({ ok: false });
  });

  it('still rejects scoped non-command Gantry facade rules', () => {
    expect(validateDurableAccessRule('FileEdit(src/index.ts)')).toEqual({
      ok: false,
      reason:
        'Only RunCommand supports persistent scoped tool rules; use an exact tool name for other tools.',
    });
  });

  it('still rejects provider-native exact tools after facade replacement', () => {
    for (const rule of [
      'Read',
      'Write',
      'Agent',
      'Task',
      'TaskCreate',
      'TaskGet',
      'TaskList',
      'TaskUpdate',
      'TodoWrite',
    ]) {
      expect(validateDurableAccessRule(rule)).toMatchObject({ ok: false });
    }
  });

  it('requires trusted definitions for semantic capabilities', () => {
    expect(
      validateDurableAccessRule('capability:skill.linkedin-posting.publish'),
    ).toEqual({
      ok: false,
      reason:
        'Unknown semantic capability skill.linkedin-posting.publish. Review and register a trusted capability definition before granting it persistently.',
    });

    expect(
      validateDurableAccessRule('capability:skill.linkedin-posting.publish', {
        semanticCapabilityDefinitions: {
          'skill.linkedin-posting.publish': skillActionDefinition,
        },
      }),
    ).toEqual({ ok: true });

    expect(validateDurableAccessRule('capability:acme.records.append')).toEqual(
      {
        ok: false,
        reason:
          'Unknown semantic capability acme.records.append. Review and register a trusted capability definition before granting it persistently.',
      },
    );

    expect(
      validateDurableAccessRule('capability:acme.records.append', {
        semanticCapabilityDefinitions: {
          'acme.records.append': localCliDefinition,
        },
      }),
    ).toEqual({ ok: true });
  });

  it('allows unknown semantic capabilities when allowUnknownSemanticCapability is set', () => {
    expect(
      validateDurableAccessRule('capability:acme.records.append', {
        allowUnknownSemanticCapability: true,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects generated runtime skill paths as durable RunCommand authority', () => {
    expect(
      validateDurableAccessRule(
        'RunCommand(/tmp/run/.llm-runtime/claude/skills/linkedin-posting/post.py *)',
      ),
    ).toEqual({
      ok: false,
      reason:
        'Persistent RunCommand rules cannot reference generated runtime skill paths; approve the selected skill action capability or a stable reviewed command wrapper instead.',
    });
  });

  it('rejects generated runtime tool result paths as durable RunCommand authority', () => {
    expect(
      validateDurableAccessRule(
        'RunCommand(tail -20 /tmp/run/.llm-runtime/claude/projects/project/run/tool-results/result.txt)',
      ),
    ).toEqual({
      ok: false,
      reason:
        'Persistent RunCommand rules cannot reference generated runtime paths; use a reviewed stable capability or let Gantry-owned runtime scratch reads stay internal.',
    });
  });

  it('rejects Gantry MCP wildcard rules as durable access rules', () => {
    expect(validateDurableAccessRule('mcp__gantry__*')).toEqual({
      ok: false,
      reason:
        'Persistent Gantry MCP wildcard grants are not supported; request one exact mcp__gantry__ tool.',
    });
    expect(validateDurableAccessRule('mcp__gantry__*(send_message)')).toEqual({
      ok: false,
      reason:
        'Persistent Gantry MCP wildcard grants are not supported; request one exact mcp__gantry__ tool.',
    });
  });

  it('rejects RunCommand rules carrying secret-like material', () => {
    expect(
      validateDurableAccessRule(
        'RunCommand(skills/poster/post.py --token sk-abcdefghij0123456789abcd)',
      ),
    ).toEqual({
      ok: false,
      reason:
        'Persistent RunCommand rules cannot include secret-like material (redaction_required); use Allow once.',
    });
  });

  it('rejects RunCommand rules with destructive redirection', () => {
    expect(
      validateDurableAccessRule(
        'RunCommand(skills/poster/post.py > /etc/passwd)',
      ),
    ).toEqual({
      ok: false,
      reason:
        'Persistent RunCommand rules cannot include destructive redirection; use Allow once.',
    });
  });

  it('rejects RunCommand rules whose leaves change shell state', () => {
    expect(validateDurableAccessRule('RunCommand(cd /tmp)')).toEqual({
      ok: false,
      reason:
        'Bash cd changes shell state and cannot be persisted as an independent leaf.',
    });
  });

  it('rejects broad durable RunCommand wildcard prefixes', () => {
    for (const rule of [
      'RunCommand(gh *)',
      'RunCommand(aws *)',
      'RunCommand(/usr/local/bin/acme *)',
      'RunCommand(gh)',
    ]) {
      expect(validateDurableAccessRule(rule)).toMatchObject({
        ok: false,
        reason: expect.stringContaining(
          'require a concrete command prefix before wildcard fallback',
        ),
      });
    }
  });

  it('allows concrete durable RunCommand prefixes before wildcard fallback', () => {
    for (const rule of [
      'RunCommand(npm run test *)',
      'RunCommand(/usr/local/bin/acme records append *)',
      'RunCommand(gh pr view)',
    ]) {
      expect(validateDurableAccessRule(rule)).toEqual({ ok: true });
    }
  });

  it('shows the scoped command pattern without exposing RunCommand syntax', () => {
    const label = formatDurableAccessRulesForUser([
      'RunCommand(/usr/local/bin/acme records append *)',
    ]);

    expect(label).toBe(
      'matching command access (/usr/local/bin/acme records append *)',
    );
    expect(label).not.toContain('RunCommand(');
  });

  it('rejects host-owned Python scripts as durable RunCommand authority', () => {
    for (const rule of [
      'RunCommand(/Users/example/scripts/dedup-append-lead.py)',
      'RunCommand(/Users/example/scripts/dedup-append-lead.py *)',
      'RunCommand(python3 /Users/example/scripts/dedup-append-lead.py)',
    ]) {
      expect(validateDurableAccessRule(rule)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('host-owned Python scripts'),
      });
    }
  });
});
