import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_ENGINE } from '../../../src/shared/agent-engine.js';

import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import {
  createJobRunDiagnostics,
  formatTerminalToolDenial,
  forwardRunnerRuntimeEvents,
  jobToolDenialIdempotencyKey,
  terminalDiagnosticsPayload,
  toolDenialEventPayload,
  updateDiagnosticsFromRuntimeEvent,
} from '@core/jobs/execution-diagnostics.js';

describe('job execution diagnostics', () => {
  it('fingerprints a denial from the run, tool, kind, and provenance seam', () => {
    const denial = {
      toolName: 'RunCommand',
      reason: 'Denied by operator.',
      denialKind: 'permission_denied' as const,
      provenanceLane: DEFAULT_AGENT_ENGINE,
      provenanceSeam: 'gate' as const,
      action: { kind: 'instruction' as const, text: 'Review job setup.' },
    };

    const key = jobToolDenialIdempotencyKey('run-1', denial);
    expect(key).toMatch(/^tool_denied:run-1:[a-f0-9]{64}$/);
    expect(
      jobToolDenialIdempotencyKey('run-1', {
        ...denial,
        reason: 'Equivalent denial wording changed.',
      }),
    ).toBe(key);
    expect(
      jobToolDenialIdempotencyKey('run-1', {
        ...denial,
        provenanceSeam: 'recovery',
      }),
    ).not.toBe(key);
  });

  it('carries instruction-only recovery as a typed action', () => {
    expect(
      toolDenialEventPayload(
        {
          toolName: 'mcp__acme__records_append',
          reason: 'Server access is unavailable.',
          denialKind: 'permission_denied',
          provenanceLane: DEFAULT_AGENT_ENGINE,
          provenanceSeam: 'recovery',
          action: {
            kind: 'instruction',
            text: 'Connect the Acme MCP server.',
          },
        },
        null,
      ),
    ).toMatchObject({
      action: {
        kind: 'instruction',
        text: 'Connect the Acme MCP server.',
      },
    });
  });

  it('uses snake_case proposal identity in denial events', () => {
    expect(
      toolDenialEventPayload(
        {
          toolName: 'capability_run',
          reason: 'The reviewed command template does not match.',
          denialKind: 'capability_template_mismatch',
          provenanceLane: 'host',
          provenanceSeam: 'capability_run',
          action: { kind: 'fix_proposal', proposalId: 'proposal-1' },
        },
        null,
      ),
    ).toMatchObject({
      action: { kind: 'fix_proposal', proposal_id: 'proposal-1' },
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
  it('rejects a terminal permission denial without a typed action', () => {
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
        denial_kind: 'rule_denied',
        provenance_lane: DEFAULT_AGENT_ENGINE,
        provenance_seam: 'gate',
      },
    );

    expect(diagnostics.terminalToolDenial).toBeUndefined();
  });

  it('rejects camelCase proposal identity in runner events', () => {
    const diagnostics = createJobRunDiagnostics();

    updateDiagnosticsFromRuntimeEvent(
      diagnostics,
      RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
      {
        phase: 'permission_denied',
        tool: 'capability_run',
        ok: false,
        terminal: true,
        reason: 'Template mismatch.',
        denial_kind: 'capability_template_mismatch',
        provenance_lane: 'host',
        provenance_seam: 'capability_run',
        action: { kind: 'fix_proposal', proposalId: 'proposal-1' },
      },
    );

    expect(diagnostics.terminalToolDenial).toBeUndefined();
  });

  it('accepts snake_case proposal identity in runner events', () => {
    const diagnostics = createJobRunDiagnostics();

    updateDiagnosticsFromRuntimeEvent(
      diagnostics,
      RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
      {
        phase: 'permission_denied',
        tool: 'capability_run',
        ok: false,
        terminal: true,
        reason: 'Template mismatch.',
        denial_kind: 'capability_template_mismatch',
        provenance_lane: 'host',
        provenance_seam: 'capability_run',
        action: { kind: 'fix_proposal', proposal_id: 'proposal-1' },
      },
    );

    expect(diagnostics.terminalToolDenial?.action).toEqual({
      kind: 'fix_proposal',
      proposalId: 'proposal-1',
    });
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
        terminal: true,
        denial_kind: 'permission_denied',
        provenance_lane: DEFAULT_AGENT_ENGINE,
        provenance_seam: 'gate',
        action: {
          kind: 'approve_grant',
          grant: {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ tool_name: 'RunCommand', rule_content: 'npm test *' }],
          },
        },
      },
    );

    expect(formatTerminalToolDenial(diagnostics)).toContain(
      'Permission denied for Bash.',
    );
    expect(formatTerminalToolDenial(diagnostics)).toContain(
      'Recovery: Approve scoped command access, then resume the job.',
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
