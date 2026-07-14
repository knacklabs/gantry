import { describe, expect, it } from 'vitest';

import { validatePersistentRule } from '@core/application/permissions/permission-management-service.js';
import {
  permissionSuggestionKey,
  synthesizeHostPermissionSuggestions,
} from '@core/application/permissions/permission-suggestion-synthesis.js';
import { permissionUpdateAllowedToolRules } from '@core/shared/permission-tool-rules.js';

describe('host permission suggestion synthesis', () => {
  it('does not synthesize durable suggestions for third-party MCP tools', () => {
    const suggestions = synthesizeHostPermissionSuggestions(
      'mcp__github__get_issue',
      { issue: 42 },
    );
    expect(suggestions).toBeUndefined();
    expect(permissionSuggestionKey('main_agent', suggestions)).toBeUndefined();
  });

  it('derives validated RunCommand rules for Bash and drops invalid commands', () => {
    const suggestions = synthesizeHostPermissionSuggestions('Bash', {
      command: 'npm test -- --runInBand',
    });
    expect(suggestions).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [
          { toolName: 'RunCommand', ruleContent: 'npm test -- --runInBand' },
        ],
      },
    ]);
    expect(
      synthesizeHostPermissionSuggestions('RunCommand', {
        command: 'python3 /tmp/check.py',
      }),
    ).toBeUndefined();
  });

  it('only returns rules accepted by the persistent grant validator', () => {
    const suggestions = synthesizeHostPermissionSuggestions('Bash', {
      command: 'git status',
    });
    const rules = permissionUpdateAllowedToolRules(suggestions);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(() => validatePersistentRule(rule)).not.toThrow();
    }
  });
});
