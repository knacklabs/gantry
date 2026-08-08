import { describe, expect, it } from 'vitest';

import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import {
  createJobRunDiagnostics,
  formatTerminalToolDenial,
  forwardRunnerRuntimeEvents,
  terminalDiagnosticsPayload,
  toolDenialEventPayload,
  updateDiagnosticsFromRuntimeEvent,
} from '@core/jobs/execution-diagnostics.js';

describe('job execution diagnostics', () => {
  it('classifies MCP server requests as instruction-only recovery', () => {
    expect(
      toolDenialEventPayload(
        {
          toolName: 'mcp__acme__records_append',
          grantable: false,
          recoveryAction: 'request_mcp_server {"serverName":"acme"}',
        },
        null,
      ),
    ).toMatchObject({
      grantable: false,
      recovery_kind: 'job_policy',
    });
  });

  it('treats partial or inconsistent human-once provenance as transient (fail closed)', () => {
    for (const provenance of [
      { source: 'human_once' }, // repeatable flag missing
      { repeatableForFutureRuns: false }, // source missing
      { source: 'human_once', repeatableForFutureRuns: true }, // inconsistent
    ]) {
      const diagnostics = createJobRunDiagnostics();
      updateDiagnosticsFromRuntimeEvent(
        diagnostics,
        RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
        {
          phase: 'permission_allowed',
          tool: 'Bash',
          mode: 'allow_once',
          decidedBy: 'owner',
          ok: true,
          ...provenance,
        },
      );
      expect(diagnostics.transientPermissionApprovals).toHaveLength(1);
    }
  });
  it('retains a terminal permission denial and its specific tool name', () => {
    const diagnostics = createJobRunDiagnostics();

    updateDiagnosticsFromRuntimeEvent(
      diagnostics,
      RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
      {
        phase: 'permission_denied',
        tool: 'Bash',
        ok: false,
        terminal: true,
        reason: 'Bash command could not be parsed safely.',
      },
    );

    expect(diagnostics.terminalToolDenial).toEqual({
      toolName: 'Bash',
      reason: 'Bash command could not be parsed safely.',
      recoveryAction: undefined,
    });
    expect(formatTerminalToolDenial(diagnostics)).toContain(
      'Permission denied for Bash.',
    );
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

  it('keeps recurring jobs active across automatic allow-once decisions from every policy source', () => {
    const automaticDecisions = [
      {
        decidedBy: 'auto_classifier',
        source: 'auto_classifier',
      },
      {
        decidedBy: 'cached_classifier_verdict',
        source: 'cached_classifier',
      },
      {
        decidedBy: 'trusted_root_grant',
        source: 'trusted_root',
      },
      { decidedBy: 'birthright', source: 'birthright' },
      {
        decidedBy: 'deterministic_read_only',
        source: 'deterministic_policy',
      },
      { decidedBy: 'reviewed_rule', source: 'durable_rule' },
    ];
    const diagnostics = createJobRunDiagnostics();

    for (const decision of automaticDecisions) {
      updateDiagnosticsFromRuntimeEvent(
        diagnostics,
        RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
        {
          phase: 'permission_allowed',
          tool: 'Bash',
          mode: 'allow_once',
          repeatableForFutureRuns: true,
          ok: true,
          ...decision,
        },
      );
    }

    expect(diagnostics.transientPermissionApprovals).toEqual([]);
  });

  it('pauses only for explicit non-repeatable human one-time consent', () => {
    for (const decidedBy of ['human', 'user:approver']) {
      const diagnostics = createJobRunDiagnostics();

      updateDiagnosticsFromRuntimeEvent(
        diagnostics,
        RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
        {
          phase: 'permission_allowed',
          tool: 'Bash',
          mode: 'allow_once',
          decidedBy,
          source: 'human_once',
          repeatableForFutureRuns: false,
          ok: true,
        },
      );

      expect(diagnostics.transientPermissionApprovals).toEqual([
        {
          toolName: 'Bash',
          mode: 'allow_once',
        },
      ]);
    }

    const repeatable = createJobRunDiagnostics();
    updateDiagnosticsFromRuntimeEvent(
      repeatable,
      RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
      {
        phase: 'permission_allowed',
        tool: 'Bash',
        mode: 'allow_once',
        decidedBy: 'human',
        source: 'human_persistent',
        repeatableForFutureRuns: true,
        ok: true,
      },
    );
    expect(repeatable.transientPermissionApprovals).toEqual([]);
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
