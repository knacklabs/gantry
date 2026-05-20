import { describe, expect, it } from 'vitest';

import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import {
  createJobRunDiagnostics,
  formatTerminalToolDenial,
  updateDiagnosticsFromRuntimeEvent,
} from '@core/jobs/execution-diagnostics.js';

describe('execution diagnostics', () => {
  it('does not turn non-terminal permission denials into run errors', () => {
    const diagnostics = createJobRunDiagnostics();

    updateDiagnosticsFromRuntimeEvent(
      diagnostics,
      RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
      {
        phase: 'permission_denied',
        tool: 'Bash',
        ok: false,
        terminal: false,
        reason: 'Bash command could not be parsed safely.',
      },
    );

    expect(diagnostics.terminalToolDenial).toBeUndefined();
    expect(formatTerminalToolDenial(diagnostics)).toBeUndefined();
  });

  it('keeps promptable permission denials terminal by default', () => {
    const diagnostics = createJobRunDiagnostics();

    updateDiagnosticsFromRuntimeEvent(
      diagnostics,
      RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
      {
        phase: 'permission_denied',
        tool: 'Bash',
        ok: false,
        reason: 'Denied by operator.',
        recovery_action:
          'request_permission {"toolName":"RunCommand","rule":"npm test *"}',
      },
    );

    expect(formatTerminalToolDenial(diagnostics)).toContain(
      'Permission denied for Bash.',
    );
  });

  it('carries recovery actions from transient permission approvals', () => {
    const diagnostics = createJobRunDiagnostics();

    updateDiagnosticsFromRuntimeEvent(
      diagnostics,
      RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
      {
        phase: 'permission_wait',
        tool: 'Bash',
        ok: false,
        reason: 'Tool not on autonomous run allowlist: RunCommand.',
        recovery_action:
          'request_permission {"toolName":"RunCommand","rule":"npm test *"}',
      },
    );
    updateDiagnosticsFromRuntimeEvent(
      diagnostics,
      RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
      {
        phase: 'permission_allowed',
        tool: 'Bash',
        mode: 'allow_once',
        ok: true,
      },
    );

    expect(diagnostics.transientPermissionApprovals).toEqual([
      {
        toolName: 'Bash',
        mode: 'allow_once',
        recoveryAction:
          'request_permission {"toolName":"RunCommand","rule":"npm test *"}',
      },
    ]);
  });
});
