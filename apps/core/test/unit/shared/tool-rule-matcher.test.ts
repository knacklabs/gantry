import { describe, expect, it } from 'vitest';

import {
  anyToolRuleMatches,
  evaluateAutonomousToolUse,
  validateAutonomousToolRule,
} from '@core/shared/tool-rule-matcher.js';

describe('autonomous tool rule matcher', () => {
  it('supports exact tool names and mcp server wildcards', () => {
    expect(anyToolRuleMatches(['Bash'], 'Bash')).toBe(true);
    expect(anyToolRuleMatches(['Bash'], 'Read')).toBe(false);
    expect(anyToolRuleMatches(['mcp__github__*'], 'mcp__github__search')).toBe(
      true,
    );
    expect(anyToolRuleMatches(['mcp__github__*'], 'mcp__linear__search')).toBe(
      false,
    );
  });

  it('rejects empty, global, and unsupported wildcard rules', () => {
    expect(validateAutonomousToolRule('').ok).toBe(false);
    expect(validateAutonomousToolRule('*').ok).toBe(false);
    expect(validateAutonomousToolRule('mcp__github__search*').ok).toBe(false);
    expect(validateAutonomousToolRule('mcp__github__*').ok).toBe(true);
  });

  it('allows scoped Bash commands and denies unrelated Bash commands', () => {
    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(dedup-append-lead.py *)'],
        toolName: 'Bash',
        toolInput: { command: 'dedup-append-lead.py --dry-run' },
      }),
    ).toMatchObject({ allowed: true });

    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(dedup-append-lead.py *)'],
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('did not match'),
    });
  });

  it('allows exact Bash to cover any Bash input only when configured', () => {
    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash'],
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      }),
    ).toMatchObject({ allowed: true });

    expect(
      evaluateAutonomousToolUse({
        rules: ['Read'],
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      }),
    ).toMatchObject({ allowed: false });
  });

  it('matches known path, query, pattern, and url fields only', () => {
    expect(
      evaluateAutonomousToolUse({
        rules: ['Read(/repo/docs/FACTORY.md)'],
        toolName: 'Read',
        toolInput: { file_path: '/repo/docs/FACTORY.md' },
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAutonomousToolUse({
        rules: ['Grep(todo *)'],
        toolName: 'Grep',
        toolInput: { pattern: 'todo cleanup' },
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAutonomousToolUse({
        rules: ['WebSearch(MyClaw scheduler)'],
        toolName: 'WebSearch',
        toolInput: { query: 'MyClaw scheduler' },
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAutonomousToolUse({
        rules: ['WebFetch(domain:example.com)'],
        toolName: 'WebFetch',
        toolInput: { url: 'https://docs.example.com/path' },
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAutonomousToolUse({
        rules: ['Read(/repo/docs/FACTORY.md)'],
        toolName: 'Read',
        toolInput: { pattern: '/repo/docs/FACTORY.md' },
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('expected one of'),
    });
  });

  it('fails closed for unknown scoped tools and unsupported input shapes', () => {
    expect(validateAutonomousToolRule('CustomTool(scope)').ok).toBe(false);
    expect(
      evaluateAutonomousToolUse({
        rules: ['CustomTool(scope)'],
        toolName: 'CustomTool',
        toolInput: { scope: 'scope' },
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('unsupported tool'),
    });
    expect(
      evaluateAutonomousToolUse({
        rules: ['Read(/repo/file.md)'],
        toolName: 'Read',
        toolInput: { unknown: '/repo/file.md' },
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('expected one of'),
    });
  });

  it('keeps MCP wildcard behavior unchanged', () => {
    expect(
      evaluateAutonomousToolUse({
        rules: ['mcp__agent_browser__*'],
        toolName: 'mcp__agent_browser__open',
        toolInput: {},
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAutonomousToolUse({
        rules: ['mcp__agent_browser__*'],
        toolName: 'mcp__github__search',
        toolInput: {},
      }),
    ).toMatchObject({ allowed: false });
  });

  it('validates scoped wildcards only inside registered scoped tool rules', () => {
    expect(validateAutonomousToolRule('Bash(dedup-append-lead.py *)').ok).toBe(
      true,
    );
    expect(validateAutonomousToolRule('Read(/repo/**)').ok).toBe(true);
    expect(validateAutonomousToolRule('Bash()').ok).toBe(false);
    expect(validateAutonomousToolRule('Bash(npm test').ok).toBe(false);
    expect(validateAutonomousToolRule('Bash(npm test) extra').ok).toBe(false);
    expect(
      validateAutonomousToolRule('mcp__myclaw__*(service_restart)').ok,
    ).toBe(false);
  });
});
