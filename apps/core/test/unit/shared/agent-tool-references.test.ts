import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GANTRY_HARNESS_TOOL_PROJECTION,
  GANTRY_FACADE_EXACT_TOOL_NAMES,
  projectGantryToolRuleForHarness,
  providerNativeToolRejectionReason,
  SDK_SANDBOX_NETWORK_ACCESS_REJECTION_REASON,
  validateGantryFacadeToolInput,
  validateReadableAgentToolRule,
} from '@core/shared/agent-tool-references.js';

describe('agent tool references', () => {
  it('rejects durable SDK sandbox network access rules', () => {
    expect(validateReadableAgentToolRule('SandboxNetworkAccess')).toEqual({
      ok: false,
      reason: SDK_SANDBOX_NETWORK_ACCESS_REJECTION_REASON,
    });
    expect(validateReadableAgentToolRule('SandboxNetworkAccess(*)')).toEqual({
      ok: false,
      reason: SDK_SANDBOX_NETWORK_ACCESS_REJECTION_REASON,
    });
  });

  it('rejects provider-native SDK tools as durable Gantry rules', () => {
    for (const toolName of [
      'Agent',
      'AskUserQuestion',
      'CronCreate',
      'CronDelete',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'LS',
      'MultiEdit',
      'NotebookEdit',
      'WebFetch',
      'ToolSearch',
      'Skill',
      'Task',
      'TaskCreate',
      'TaskGet',
      'TaskList',
      'TaskOutput',
      'TaskUpdate',
      'TodoWrite',
    ]) {
      expect(validateReadableAgentToolRule(toolName)).toEqual({
        ok: false,
        reason: providerNativeToolRejectionReason(toolName),
      });
    }
    expect(validateReadableAgentToolRule('Browser')).toEqual({ ok: true });
    for (const toolName of [
      'WebSearch',
      'WebRead',
      'FileSearch',
      'FileRead',
      'FileEdit',
      'FileWrite',
      'AgentDelegation',
    ]) {
      expect(validateReadableAgentToolRule(toolName)).toEqual({ ok: true });
    }
    expect(validateReadableAgentToolRule('Bash(npm test *)')).toEqual({
      ok: false,
      reason: providerNativeToolRejectionReason('Bash'),
    });
    expect(validateReadableAgentToolRule('Task')).toEqual({
      ok: false,
      reason: expect.stringContaining('AgentDelegation'),
    });
    expect(validateReadableAgentToolRule('RunCommand(npm test *)')).toEqual({
      ok: true,
    });
  });

  it('enforces Gantry file facade path and glob semantics', () => {
    expect(
      validateGantryFacadeToolInput('FileSearch', {
        mode: 'path',
        query: 'apps/**/*.ts',
        include: ['apps/**'],
        exclude: 'node_modules/**',
      }),
    ).toEqual({ ok: true });
    expect(
      validateGantryFacadeToolInput('FileSearch', {
        mode: 'content',
        query: 'executionProviderId',
        include: 'apps/**/*.ts',
      }),
    ).toEqual({ ok: true });
    expect(
      validateGantryFacadeToolInput('FileSearch', {
        mode: 'content',
        query: '*.ts',
      }),
    ).toMatchObject({ ok: false });
    for (const toolName of ['FileRead', 'FileEdit', 'FileWrite'] as const) {
      expect(
        validateGantryFacadeToolInput(toolName, {
          path: 'apps/**/*.ts',
          ...(toolName === 'FileEdit' ? { patch: 'diff' } : {}),
          ...(toolName === 'FileWrite' ? { content: 'text' } : {}),
        }),
      ).toMatchObject({ ok: false });
      expect(
        validateGantryFacadeToolInput(toolName, {
          path: 'apps/core/src/index.ts',
          ...(toolName === 'FileEdit' ? { patch: 'diff' } : {}),
          ...(toolName === 'FileWrite' ? { content: 'text' } : {}),
        }),
      ).toEqual({ ok: true });
    }
  });

  it('projects Gantry facades through harness-specific internal tool names', () => {
    expect(
      projectGantryToolRuleForHarness('FileSearch', {
        exactTools: { FileSearch: ['Glob', 'Grep'] },
        runCommandToolName: 'Bash',
      }),
    ).toEqual(['Glob', 'Grep']);
    expect(
      projectGantryToolRuleForHarness('RunCommand(npm test *)', {
        exactTools: {},
        runCommandToolName: 'Bash',
      }),
    ).toEqual(['Bash']);
    expect(
      projectGantryToolRuleForHarness('FileSearch', {
        exactTools: { FileSearch: ['codex_file_glob', 'codex_file_grep'] },
        runCommandToolName: 'codex_exec',
      }),
    ).toEqual(['codex_file_glob', 'codex_file_grep']);
    expect(
      projectGantryToolRuleForHarness('FileWrite', {
        exactTools: {},
      }),
    ).toEqual([]);
  });

  it('renders every Gantry facade under the default harness projection', () => {
    // Authority invariant: a facade that exists as durable authority must
    // project to at least one harness-native tool unless it is explicitly
    // implemented only through Gantry MCP wrappers. Guards against adding a
    // facade without wiring it into the renderer projection.
    for (const facade of GANTRY_FACADE_EXACT_TOOL_NAMES) {
      if (facade === 'AgentDelegation') continue;
      expect(
        projectGantryToolRuleForHarness(
          facade,
          DEFAULT_GANTRY_HARNESS_TOOL_PROJECTION,
        ),
        facade,
      ).not.toHaveLength(0);
    }
    expect(
      projectGantryToolRuleForHarness(
        'AgentDelegation',
        DEFAULT_GANTRY_HARNESS_TOOL_PROJECTION,
      ),
    ).toEqual([]);
    expect(
      DEFAULT_GANTRY_HARNESS_TOOL_PROJECTION.runCommandToolName,
    ).toBeTruthy();
  });
});
