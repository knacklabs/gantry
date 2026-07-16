import { describe, expect, it } from 'vitest';

import { isPermissionClassifierEligible } from '@core/application/permissions/permission-classifier.js';

describe('permission classifier gray-zone eligibility', () => {
  it.each([
    ['Bash', true],
    ['RunCommand', true],
    ['mcp__github__search', true],
    ['mcp__github__pull_requests.list', true],
    ['mcp__server-1__operation_name', true],
    ['mcp__gantry__request_access', false],
    ['mcp__gantry__browser_open', false],
    ['WebSearch', false],
    ['WebRead', false],
    ['FileSearch', false],
    ['FileRead', false],
    ['FileEdit', false],
    ['FileWrite', false],
    ['AgentDelegation', false],
    ['send_message', false],
    ['ask_user_question', false],
    ['memory_search', false],
    ['memory_save', false],
    ['delegate_task', false],
    ['task_get', false],
    ['task_list', false],
    ['task_cancel', false],
    ['task_message', false],
    ['request_access', false],
    ['request_permission', false],
    ['mcp__missing_operation', false],
    ['mcp____operation', false],
    ['mcp__server__', false],
    ['mcp__server__operation name', false],
    ['mcp__server__operation/path', false],
    [' mcp__github__search', false],
    ['mcp__github__search ', false],
    ['bash', false],
    [' Bash', false],
    ['RunCommand ', false],
    ['RunCommand(ls)', false],
    ['', false],
  ])('classifies tool-family canonical name %s as %s', (toolName, expected) => {
    expect(isPermissionClassifierEligible(toolName, 'tool')).toBe(expected);
  });

  it.each(['admin', 'review', 'promotion'] as const)(
    'excludes the %s request family even for otherwise eligible tools',
    (family) => {
      expect(isPermissionClassifierEligible('Bash', family)).toBe(false);
      expect(isPermissionClassifierEligible('RunCommand', family)).toBe(false);
      expect(
        isPermissionClassifierEligible('mcp__github__search', family),
      ).toBe(false);
    },
  );
});
