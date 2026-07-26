import { describe, expect, it } from 'vitest';

import {
  ADMIN_MCP_TOOL_FULL_NAMES,
  ALL_GANTRY_MCP_TOOL_NAMES,
  AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
  classifyDurableGantryMcpToolName,
  DECISION_ACTOR_GANTRY_MCP_TOOL_NAMES,
  DELEGATION_DISPATCHERS,
  type DurableGantryMcpToolBucket,
  DURABLE_GRANT_EXCLUDED_DISPATCHERS,
  GATED_GANTRY_MCP_TOOL_NAMES,
  GRANTABLE_EXACT_GANTRY_MCP_TOOL_NAMES,
  SEEDED_SCHEDULER_MCP_TOOL_FULL_NAMES,
  isSeededGantryMcpToolFullName,
} from '@core/shared/admin-mcp-tools.js';

describe('admin MCP tools', () => {
  it('identifies exactly the fixed-ID Gantry seed families', () => {
    for (const fullName of ADMIN_MCP_TOOL_FULL_NAMES) {
      expect(isSeededGantryMcpToolFullName(fullName)).toBe(true);
    }
    for (const fullName of SEEDED_SCHEDULER_MCP_TOOL_FULL_NAMES) {
      expect(isSeededGantryMcpToolFullName(fullName)).toBe(true);
    }

    expect(
      isSeededGantryMcpToolFullName('mcp__gantry__scheduler_resume_job'),
    ).toBe(false);
    expect(isSeededGantryMcpToolFullName('mcp__gantry__task_cancel')).toBe(
      false,
    );
  });

  it('classifies every Gantry MCP tool into exactly one durable-grant bucket', () => {
    const buckets: readonly [DurableGantryMcpToolBucket, readonly string[]][] =
      [
        ['grantable-exact', GRANTABLE_EXACT_GANTRY_MCP_TOOL_NAMES],
        ['runtime-projection', GATED_GANTRY_MCP_TOOL_NAMES],
        ['unscoped-dispatcher', DURABLE_GRANT_EXCLUDED_DISPATCHERS],
        ['delegation', DELEGATION_DISPATCHERS],
        ['authority-changing', AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES],
        ['decision-actor', DECISION_ACTOR_GANTRY_MCP_TOOL_NAMES],
      ];

    expect(new Set(ALL_GANTRY_MCP_TOOL_NAMES).size).toBe(
      ALL_GANTRY_MCP_TOOL_NAMES.length,
    );
    for (const toolName of ALL_GANTRY_MCP_TOOL_NAMES) {
      const memberships = buckets
        .filter(([, names]) => names.includes(toolName))
        .map(([bucket]) => bucket);
      expect(memberships, toolName).toEqual([
        classifyDurableGantryMcpToolName(toolName),
      ]);
    }
  });
});
