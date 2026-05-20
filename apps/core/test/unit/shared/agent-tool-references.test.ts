import { describe, expect, it } from 'vitest';

import {
  PROVIDER_NATIVE_TOOL_REJECTION_REASON,
  SDK_SANDBOX_NETWORK_ACCESS_REJECTION_REASON,
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
      'WebSearch',
      'ToolSearch',
      'Skill',
      'Task',
      'TaskOutput',
      'TodoWrite',
    ]) {
      expect(validateReadableAgentToolRule(toolName)).toEqual({
        ok: false,
        reason: PROVIDER_NATIVE_TOOL_REJECTION_REASON,
      });
    }
    expect(validateReadableAgentToolRule('Browser')).toEqual({ ok: true });
    expect(validateReadableAgentToolRule('Bash(npm test *)')).toEqual({
      ok: true,
    });
  });
});
