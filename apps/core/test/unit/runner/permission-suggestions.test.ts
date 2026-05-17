import { describe, expect, it } from 'vitest';

import {
  scheduledPermissionSuggestions,
  synthesizePermissionSuggestions,
} from '@core/runner/claude/permission-suggestions.js';

describe('scheduledPermissionSuggestions', () => {
  it('canonicalizes projected browser tool suggestions to Browser', () => {
    expect(
      scheduledPermissionSuggestions(
        'mcp__myclaw__browser_act',
        [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'mcp__myclaw__browser_act' }],
          },
        ],
        {},
      ),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Browser' }],
      },
    ]);
  });

  it('keeps SDK scoped Bash suggestions scoped', () => {
    expect(
      scheduledPermissionSuggestions(
        'Bash',
        [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          },
        ],
        {},
      ),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
      },
    ]);
  });

  it('synthesizes scoped Bash suggestions from parsed command leaves', () => {
    expect(
      synthesizePermissionSuggestions('Bash', {
        toolInput: { command: 'npm test -- --runInBand' },
      }),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test -- --runInBand' }],
      },
    ]);

    expect(
      synthesizePermissionSuggestions('Bash', {
        toolInput: { command: 'python3 /tmp/check.py' },
      }),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Bash', ruleContent: '/tmp/check.py *' }],
      },
    ]);

    expect(
      synthesizePermissionSuggestions('Bash', {
        toolInput: { command: 'python3 /tmp/check.py \'[["lead"]]\'' },
      }),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Bash', ruleContent: '/tmp/check.py *' }],
      },
    ]);
  });

  it('does not offer persistent suggestions for invalid durable tool rules', () => {
    expect(
      synthesizePermissionSuggestions(
        'mcp__browser' + '_' + 'backend' + '__navigate',
        {},
      ),
    ).toBeUndefined();
    expect(synthesizePermissionSuggestions('Read', {})).toBeUndefined();
    expect(
      synthesizePermissionSuggestions('mcp__github__search', {}),
    ).toBeUndefined();
    expect(
      scheduledPermissionSuggestions('mcp__github__*', undefined, {}),
    ).toBeUndefined();
    expect(synthesizePermissionSuggestions('Bash', {})).toBeUndefined();
    expect(
      synthesizePermissionSuggestions('Bash', { toolInput: { command: '*' } }),
    ).toBeUndefined();
    expect(
      scheduledPermissionSuggestions(
        'Bash',
        [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'Bash', ruleContent: '*' }],
          },
        ],
        {},
      ),
    ).toBeUndefined();
    expect(
      synthesizePermissionSuggestions('Bash', {
        toolInput: { command: 'cat secrets.env > /etc/passwd' },
      }),
    ).toBeUndefined();
    expect(
      synthesizePermissionSuggestions('Bash', {
        toolInput: { command: '/bin/sh -c "npm test"' },
      }),
    ).toBeUndefined();
    expect(
      synthesizePermissionSuggestions('Bash', {
        toolInput: { command: '/usr/bin/env npm test' },
      }),
    ).toBeUndefined();
    expect(
      synthesizePermissionSuggestions('Bash', {
        toolInput: { command: 'cd a && git status' },
      }),
    ).toBeUndefined();
    expect(
      scheduledPermissionSuggestions(
        'SandboxNetworkAccess',
        [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'SandboxNetworkAccess' }],
          },
        ],
        { toolInput: { host: 'registry.npmjs.org' } },
      ),
    ).toBeUndefined();
  });
});
