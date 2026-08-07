import { describe, expect, it, vi } from 'vitest';

import { denyNonPromptableAutonomousRecovery } from '@core/adapters/llm/anthropic-claude-agent/runner/autonomous-permission-recovery.js';
import { parseAutonomousToolDenial } from '@core/shared/autonomous-tool-denial.js';

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
      recoveryMessage:
        'Protected capability cannot be granted. Recovery: manual_configuration_required',
      toolName: 'Bash',
      toolPolicyReason: 'Protected capability cannot be granted.',
    });

    expect(result).toMatchObject({ behavior: 'deny', interrupt: true });
    expect(parseAutonomousToolDenial(result?.message)).toEqual({
      toolName: 'Bash',
      recoveryAction: 'manual_configuration_required',
    });
  });
});
