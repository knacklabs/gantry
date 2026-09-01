import { describe, expect, it } from 'vitest';

import {
  BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON,
  PROJECTED_BROWSER_MCP_TOOL_NAMES,
} from '@core/shared/agent-tool-references.js';
import {
  AUTHORITY_CHANGING_GANTRY_MCP_TOOL_REJECTION_REASON,
  DECISION_ACTOR_GANTRY_MCP_TOOL_REJECTION_REASON,
  DELEGATION_DISPATCHER_REJECTION_REASON,
  DURABLE_GRANT_EXCLUDED_DISPATCHER_REJECTION_REASON,
  formatDurableAccessRulesForUser,
  isDurableAccessRuleAllowed,
  validateDurableAccessRule,
} from '@core/shared/durable-access-policy.js';
import {
  AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
  DECISION_ACTOR_GANTRY_MCP_TOOL_NAMES,
  DELEGATION_DISPATCHERS,
  DURABLE_GRANT_EXCLUDED_DISPATCHERS,
  GRANTABLE_EXACT_GANTRY_MCP_TOOL_NAMES,
} from '@core/shared/admin-mcp-tools.js';
import type { SemanticCapabilityDefinition } from '@core/shared/semantic-capabilities.js';
import { isFamilyRunCommandRule } from '@core/shared/family-rule-synthesis.js';

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

  it('allows scheduler resume as a durable access rule', () => {
    expect(
      validateDurableAccessRule('mcp__gantry__scheduler_resume_job'),
    ).toEqual({ ok: true });
  });

  it('allows every canonical Gantry tool except durable exclusions and runtime projections', () => {
    for (const toolName of GRANTABLE_EXACT_GANTRY_MCP_TOOL_NAMES) {
      expect(
        validateDurableAccessRule(`mcp__gantry__${toolName}`),
        toolName,
      ).toEqual({ ok: true });
    }
  });

  it('rejects async_run_command with the dispatcher reason', () => {
    expect(validateDurableAccessRule('mcp__gantry__async_run_command')).toEqual(
      {
        ok: false,
        reason: DURABLE_GRANT_EXCLUDED_DISPATCHER_REJECTION_REASON,
      },
    );
  });

  it('rejects every durable-grant-excluded dispatcher by the shared constant', () => {
    for (const toolName of DURABLE_GRANT_EXCLUDED_DISPATCHERS) {
      expect(validateDurableAccessRule(`mcp__gantry__${toolName}`)).toEqual({
        ok: false,
        reason: DURABLE_GRANT_EXCLUDED_DISPATCHER_REJECTION_REASON,
      });
    }
  });

  it('rejects delegation dispatchers as durable access rules', () => {
    for (const toolName of DELEGATION_DISPATCHERS) {
      expect(
        validateDurableAccessRule(`mcp__gantry__${toolName}`),
        toolName,
      ).toEqual({
        ok: false,
        reason: DELEGATION_DISPATCHER_REJECTION_REASON,
      });
    }
  });

  it('rejects scoped forms of excluded Gantry tools by the underlying exact name', () => {
    expect(
      validateDurableAccessRule('mcp__gantry__request_access(capability:test)'),
    ).toEqual({
      ok: false,
      reason: AUTHORITY_CHANGING_GANTRY_MCP_TOOL_REJECTION_REASON,
    });
  });

  it('rejects a fabricated Gantry tool name', () => {
    expect(
      validateDurableAccessRule('mcp__gantry__does_not_exist'),
    ).toMatchObject({ ok: false });
  });

  it('rejects a typo of a canonical Gantry tool name', () => {
    expect(
      validateDurableAccessRule('mcp__gantry__scheduler_resume_jobb'),
    ).toMatchObject({ ok: false });
  });

  it('rejects every authority-changing Gantry tool by the shared constant', () => {
    for (const toolName of AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES) {
      expect(
        validateDurableAccessRule(`mcp__gantry__${toolName}`),
        toolName,
      ).toEqual({
        ok: false,
        reason: AUTHORITY_CHANGING_GANTRY_MCP_TOOL_REJECTION_REASON,
      });
    }
  });

  it('rejects authority, config, topology, and restart mutations outside the request family', () => {
    for (const toolName of [
      'admin_permission_revoke',
      'register_agent',
      'request_settings_update',
      'service_restart',
    ]) {
      expect(
        validateDurableAccessRule(`mcp__gantry__${toolName}`),
        toolName,
      ).toEqual({
        ok: false,
        reason: AUTHORITY_CHANGING_GANTRY_MCP_TOOL_REJECTION_REASON,
      });
    }
  });

  it('rejects tools that record durable user consent or review decisions', () => {
    for (const toolName of DECISION_ACTOR_GANTRY_MCP_TOOL_NAMES) {
      expect(
        validateDurableAccessRule(`mcp__gantry__${toolName}`),
        toolName,
      ).toEqual({
        ok: false,
        reason: DECISION_ACTOR_GANTRY_MCP_TOOL_REJECTION_REASON,
      });
    }
  });

  it('keeps read-only admin and settings tools grantable', () => {
    for (const toolName of [
      'admin_permission_list',
      'guided_action_preview',
      'settings_desired_state',
    ]) {
      expect(
        validateDurableAccessRule(`mcp__gantry__${toolName}`),
        toolName,
      ).toEqual({ ok: true });
    }
  });

  it('keeps reads, scheduler job CRUD, memory writes, and task cancellation grantable', () => {
    for (const toolName of [
      'task_get',
      'task_list',
      'task_cancel',
      'scheduler_get_job',
      'scheduler_list_jobs',
      'scheduler_upsert_job',
      'scheduler_update_job',
      'scheduler_delete_job',
      'scheduler_pause_job',
      'scheduler_resume_job',
      'memory_search',
      'memory_save',
      'memory_patch',
      'memory_demote',
      'memory_dream',
      'memory_consolidate',
      'brain_write',
    ]) {
      expect(
        validateDurableAccessRule(`mcp__gantry__${toolName}`),
        toolName,
      ).toEqual({ ok: true });
    }
  });

  it('rejects projected Gantry browser tools in favor of canonical Browser', () => {
    for (const toolName of PROJECTED_BROWSER_MCP_TOOL_NAMES) {
      expect(validateDurableAccessRule(toolName), toolName).toEqual({
        ok: false,
        reason: BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON,
      });
    }
  });

  it('renders readable names for newly durable Gantry tools', () => {
    expect(
      formatDurableAccessRulesForUser([
        'mcp__gantry__scheduler_resume_job',
        'mcp__gantry__task_cancel',
        'mcp__gantry__memory_patch',
      ]),
    ).toBe('Scheduler Resume Job, Task Cancel, Memory Patch');
  });

  it('rejects arbitrary non-Gantry tool names', () => {
    for (const toolName of [
      'mcp__github__get_issue',
      'mcp__other__tool',
      'random string',
    ]) {
      expect(validateDurableAccessRule(toolName), toolName).toMatchObject({
        ok: false,
      });
    }
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

  it('rejects non-exact scheduler wildcard rules as durable access rules', () => {
    expect(validateDurableAccessRule('mcp__gantry__scheduler_*')).toEqual({
      ok: false,
      reason: 'Wildcard persistent tool grants are not supported.',
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

  it('allows literal-argv0 family RunCommand wildcard prefixes', () => {
    for (const rule of [
      'RunCommand(gh *)',
      'RunCommand(aws *)',
      'RunCommand(/usr/local/bin/acme *)',
    ]) {
      expect(validateDurableAccessRule(rule)).toEqual({ ok: true });
      expect(isFamilyRunCommandRule(rule)).toBe(true);
    }
  });

  it('still rejects argument-less and script-shaped rules as families', () => {
    expect(validateDurableAccessRule('RunCommand(gh)')).toMatchObject({
      ok: false,
      reason: expect.stringContaining(
        'require a concrete command prefix before wildcard fallback',
      ),
    });
    expect(
      isFamilyRunCommandRule('RunCommand(skills/linkedin-posting/post.py *)'),
    ).toBe(false);
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
