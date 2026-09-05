import { describe, expect, it } from 'vitest';

import { isPermissionClassifierEligible } from '@core/application/permissions/permission-classifier.js';
import { PermissionLane } from '@core/domain/permission-lane.js';

describe('permission classifier gray-zone eligibility', () => {
  it.each([
    ['Bash', true],
    ['RunCommand', true],
    ['mcp__github__search', true],
    ['mcp__github__pull_requests.list', true],
    ['mcp__server-1__operation_name', true],
    // Gantry-native tools are now eligible (they receive a deterministic default
    // risk rating instead of an unconditional prompt).
    ['mcp__gantry__request_access', true],
    ['mcp__gantry__browser_open', true],
    ['mcp__gantry__scheduler_update_job', true],
    ['mcp__gantry__future_unknown_tool', true],
    // Bare canonical gantry tool names are eligible too.
    ['send_message', true],
    ['ask_user_question', true],
    ['memory_search', true],
    ['memory_save', true],
    ['delegate_task', true],
    ['task_get', true],
    ['task_list', true],
    ['task_cancel', true],
    ['task_message', true],
    ['request_access', true],
    // Provider-native facade names are not MCP-inventory tools -> ineligible.
    ['WebSearch', false],
    ['WebRead', false],
    ['FileSearch', false],
    ['FileRead', false],
    ['FileEdit', false],
    ['FileWrite', false],
    ['AgentDelegation', false],
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

  it('accepts FileWrite and FileEdit for classification only under the interactive_auto lane, keeps them ineligible with the lane absent or auto_strict, and keeps FileRead ineligible', () => {
    for (const toolName of ['FileWrite', 'FileEdit']) {
      expect(
        isPermissionClassifierEligible(
          toolName,
          'tool',
          PermissionLane.InteractiveAuto,
        ),
      ).toBe(true);
      expect(isPermissionClassifierEligible(toolName, 'tool')).toBe(false);
      expect(
        isPermissionClassifierEligible(
          toolName,
          'tool',
          PermissionLane.AutoStrict,
        ),
      ).toBe(false);
    }
    expect(
      isPermissionClassifierEligible(
        'FileRead',
        'tool',
        PermissionLane.InteractiveAuto,
      ),
    ).toBe(false);
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
