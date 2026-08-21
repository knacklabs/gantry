import { describe, expect, it, vi } from 'vitest';

import { denyNonPromptableAutonomousRecovery } from '@core/adapters/llm/anthropic-claude-agent/runner/autonomous-permission-recovery.js';

describe('Anthropic autonomous permission recovery', () => {
  it('classifies a non-promptable denial for failed-run fresh retry', () => {
    const result = denyNonPromptableAutonomousRecovery({
      agentInput: {
        appId: 'default',
        agentId: 'agent-1',
        runId: 'run-1',
        jobId: 'job-1',
        isScheduledJob: true,
      } as never,
      getNewSessionId: vi.fn(() => 'session-1'),
      recoveryAction: 'manual_configuration_required',
      toolInput: {},
      capabilityRequestToolsHidden: false,
      recoveryMessage:
        'Protected capability cannot be granted. Recovery: manual_configuration_required',
      toolName: 'Bash',
      toolPolicyReason: 'Protected capability cannot be granted.',
    });

    expect(result).toMatchObject({ behavior: 'deny', interrupt: true });
    expect(result?.message).toContain(
      'Tool not on autonomous run allowlist: Bash.',
    );
  });
});
