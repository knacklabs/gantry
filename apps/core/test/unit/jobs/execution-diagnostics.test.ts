import { describe, expect, it } from 'vitest';

import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import {
  createJobRunDiagnostics,
  formatTerminalToolDenial,
  forwardRunnerRuntimeEvents,
  terminalDiagnosticsPayload,
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
          'request_access {"target":{"kind":"run_command","argvPattern":"npm test *"},"temporaryOnly":false,"reason":"This autonomous run requires RunCommand(npm test *) access."}',
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
          'request_access {"target":{"kind":"run_command","argvPattern":"npm test *"},"temporaryOnly":false,"reason":"This autonomous run requires RunCommand(npm test *) access."}',
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
          'request_access {"target":{"kind":"run_command","argvPattern":"npm test *"},"temporaryOnly":false,"reason":"This autonomous run requires RunCommand(npm test *) access."}',
      },
    ]);
  });

  it('aggregates startup diagnostics with sanitized count and timing fields', () => {
    const diagnostics = createJobRunDiagnostics();

    updateDiagnosticsFromRuntimeEvent(
      diagnostics,
      RUNTIME_EVENT_TYPES.RUN_STARTUP_DIAGNOSTIC,
      {
        provider: 'deepagents',
        diagnostic: 'runner_startup',
        modelProvider: 'openai',
        modelId: 'gpt-test',
        totalMs: 42,
        phases: {
          mcpConnectMs: 12,
          streamNormalizeMs: 20,
        },
        sandbox: {
          enforcing: true,
          protectedReadPathCount: 2,
        },
        promptText: 'do not store prompt text',
        gatewayBaseUrl: 'http://127.0.0.1:1234/openai',
        gatewayToken: 'gtw_secret_token',
        rawToolArgs: { message: 'secret tool arg' },
      },
    );

    expect(diagnostics.startupDiagnostics).toEqual([
      {
        provider: 'deepagents',
        diagnostic: 'runner_startup',
        modelProvider: 'openai',
        modelId: 'gpt-test',
        totalMs: 42,
        phases: {
          mcpConnectMs: 12,
          streamNormalizeMs: 20,
        },
        sandbox: {
          enforcing: true,
          protectedReadPathCount: 2,
        },
      },
    ]);
    const terminal = terminalDiagnosticsPayload(diagnostics);
    expect(terminal).toMatchObject({
      startup_diagnostics: diagnostics.startupDiagnostics,
    });
    const serialized = JSON.stringify(terminal);
    expect(serialized).not.toContain('do not store prompt text');
    expect(serialized).not.toContain('http://127.0.0.1');
    expect(serialized).not.toContain('gtw_secret_token');
    expect(serialized).not.toContain('rawToolArgs');
    expect(serialized).not.toContain('secret tool arg');
  });

  it('forwards runner startup diagnostics into job events and diagnostics', async () => {
    const diagnostics = createJobRunDiagnostics();
    const emitted: Array<{
      eventType: string;
      payload: Record<string, unknown>;
    }> = [];
    const sdkProvider = ['anthropic', 'sdk'].join('_');

    await forwardRunnerRuntimeEvents({
      events: [
        {
          eventType: RUNTIME_EVENT_TYPES.RUN_STARTUP_DIAGNOSTIC,
          payload: {
            provider: sdkProvider,
            diagnostic: 'tool_search',
            enableToolSearch: 'auto:10',
            availableToolCount: 11,
          },
        },
      ],
      diagnostics,
      emitJobEvent: async (eventType, payload) => {
        emitted.push({ eventType, payload });
      },
    });

    expect(emitted).toEqual([
      {
        eventType: RUNTIME_EVENT_TYPES.RUN_STARTUP_DIAGNOSTIC,
        payload: {
          provider: sdkProvider,
          diagnostic: 'tool_search',
          enableToolSearch: 'auto:10',
          availableToolCount: 11,
        },
      },
    ]);
    expect(diagnostics.startupDiagnostics).toEqual([
      {
        provider: sdkProvider,
        diagnostic: 'tool_search',
        enableToolSearch: 'auto:10',
        availableToolCount: 11,
      },
    ]);
  });
});
