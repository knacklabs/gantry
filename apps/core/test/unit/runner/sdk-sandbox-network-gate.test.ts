import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSdkSandboxNetworkGate,
  type SdkSandboxNetworkGate,
} from '@core/runner/claude/sdk-sandbox-network-gate.js';
import type { AgentRunnerInput } from '@core/runner/claude/types.js';
import { log } from '@core/runner/claude/logging.js';
import { writeOutput } from '@core/runner/claude/output.js';

vi.mock('@core/runner/claude/logging.js', () => ({
  log: vi.fn(),
}));

vi.mock('@core/runner/claude/output.js', () => ({
  writeOutput: vi.fn(),
}));

const runnerInput: AgentRunnerInput = {
  prompt: 'Run tests',
  appId: 'app-1',
  agentId: 'agent-1',
  groupFolder: 'team',
  chatJid: 'sl:C123',
  runId: 'run-1',
  jobId: 'job-1',
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeGate(nowRef: { value: number }): SdkSandboxNetworkGate {
  return createSdkSandboxNetworkGate(runnerInput, {
    ttlMs: 300_000,
    nowMs: () => nowRef.value,
  });
}

function latestPayload(): Record<string, unknown> {
  const call = vi.mocked(writeOutput).mock.calls.at(-1)?.[0];
  const event = call?.runtimeEvents?.[0];
  return event?.payload as Record<string, unknown>;
}

describe('sdk sandbox network gate', () => {
  beforeEach(() => {
    vi.mocked(log).mockReset();
    vi.mocked(writeOutput).mockReset();
  });

  it('allows one SDK network prompt for one approved non-Bash tool use', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'mcp__github__create_issue',
      { owner: 'acme', repo: 'roadmap' },
      { toolUseID: 'toolu_mcp_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.github.com', parentToolUseID: 'toolu_mcp_1' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision).toEqual({
      behavior: 'allow',
      updatedInput: { host: 'api.github.com', parentToolUseID: 'toolu_mcp_1' },
    });
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed',
      networkToolUseID: 'toolu_network_1',
      parentToolUseID: 'toolu_mcp_1',
      approvedToolName: 'mcp__github__create_issue',
      hostHash: sha256('api.github.com'),
      inputHash: sha256('{"owner":"acme","repo":"roadmap"}'),
      tokenCreatedAtMs: 1_000,
      tokenExpiresAtMs: 301_000,
      tokenTtlMs: 300_000,
    });
  });

  it('suppresses SDK network prompts during a global approval window', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberGlobalApproval('agent-1', 301_000);
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.linkedin.com' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision).toEqual({
      behavior: 'allow',
      updatedInput: { host: 'api.linkedin.com' },
    });
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_global_approval_suppressed',
      networkToolUseID: 'toolu_network_1',
      hostHash: sha256('api.linkedin.com'),
      tokenCreatedAtMs: 1_000,
      tokenExpiresAtMs: 301_000,
      tokenTtlMs: 300_000,
    });
  });

  it('falls back to normal network gating after global approval expires', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberGlobalApproval('agent-1', 301_000);
    now.value = 301_001;
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.linkedin.com' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseID: 'toolu_network_1',
      hostHash: sha256('api.linkedin.com'),
    });
  });

  it('does not suppress network prompts for a different timed-grant principal', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberGlobalApproval('subagent-a', 301_000);
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.linkedin.com' },
      { toolUseID: 'toolu_network_1' },
      'subagent-b',
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseID: 'toolu_network_1',
      hostHash: sha256('api.linkedin.com'),
    });
  });

  it('keeps global approvals isolated per principal', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberGlobalApproval('subagent-a', 301_000);
    gate.rememberGlobalApproval('subagent-b', 301_000);

    const first = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api-a.example' },
      { toolUseID: 'toolu_network_a' },
      'subagent-a',
    );
    const second = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api-b.example' },
      { toolUseID: 'toolu_network_b' },
      'subagent-b',
    );

    expect(first?.behavior).toBe('allow');
    expect(second?.behavior).toBe('allow');
  });

  it('allows parentless SDK network prompts for one unambiguous approved tool', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Bash',
      { cmd: 'npm test --runInBand' },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision).toEqual({
      behavior: 'allow',
      updatedInput: { host: 'registry.npmjs.org' },
    });
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed',
      networkToolUseID: 'toolu_network_1',
      parentToolUseID: 'toolu_bash_1',
      approvedToolName: 'Bash',
      hostHash: sha256('registry.npmjs.org'),
      expiredTokenCount: 0,
    });
  });

  it('does not mint a network token without a tool-use id', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool('Bash', { command: 'npm test' }, {});
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseID: 'toolu_network_1',
      expiredTokenCount: 0,
    });
  });

  it('does not mint fallback network tokens for local-only SDK tools', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Read',
      { file_path: 'package.json' },
      { toolUseID: 'toolu_read_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.github.com' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('before any tool call was allowed'),
      }),
    );
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      reason:
        'SDK requested sandbox network access before any tool call was allowed by MyClaw.',
      networkToolUseID: 'toolu_network_1',
      hostHash: sha256('api.github.com'),
      expiredTokenCount: 0,
    });
  });

  it('denies parent tool-use token suppression for a different principal', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'mcp__github__create_issue',
      { owner: 'acme', repo: 'roadmap' },
      { toolUseID: 'toolu_mcp_1' },
      'subagent-a',
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.github.com', parentToolUseID: 'toolu_mcp_1' },
      { toolUseID: 'toolu_network_1' },
      'subagent-b',
    );

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('did not approve'),
      }),
    );
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      parentToolUseID: 'toolu_mcp_1',
      networkToolUseID: 'toolu_network_1',
      hostHash: sha256('api.github.com'),
      expiredTokenCount: 0,
    });
  });

  it('allows parentless SDK network prompts when another principal also has an active token', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Bash',
      { command: 'npm install' },
      { toolUseID: 'toolu_bash_a' },
      'subagent-a',
    );
    gate.rememberAllowedTool(
      'Bash',
      { command: 'git fetch' },
      { toolUseID: 'toolu_bash_b' },
      'subagent-b',
    );

    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org' },
      { toolUseID: 'toolu_network_a' },
      'subagent-a',
    );

    expect(decision).toEqual({
      behavior: 'allow',
      updatedInput: { host: 'registry.npmjs.org' },
    });
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed',
      parentToolUseID: 'toolu_bash_a',
      approvedToolName: 'Bash',
      networkToolUseID: 'toolu_network_a',
      hostHash: sha256('registry.npmjs.org'),
    });
  });

  it('denies parentless SDK network prompts for a principal with no approved token', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Bash',
      { command: 'npm install' },
      { toolUseID: 'toolu_bash_a' },
      'subagent-a',
    );

    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org' },
      { toolUseID: 'toolu_network_b' },
      'subagent-b',
    );

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('before any tool call was allowed'),
      }),
    );
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      reason:
        'SDK requested sandbox network access before any tool call was allowed by MyClaw.',
      networkToolUseID: 'toolu_network_b',
      hostHash: sha256('registry.npmjs.org'),
      expiredTokenCount: 0,
    });
  });

  it('uses the most recent approved tool for parentless network prompts', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Bash',
      { command: 'npm test first' },
      { toolUseID: 'toolu_bash_1' },
    );
    now.value = 2_000;
    gate.rememberAllowedTool(
      'Bash',
      { command: 'npm test second' },
      { toolUseID: 'toolu_bash_2' },
    );

    const ambiguous = gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org' },
      { toolUseID: 'toolu_network_1' },
    );
    expect(ambiguous).toEqual({
      behavior: 'allow',
      updatedInput: { host: 'registry.npmjs.org' },
    });
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed',
      parentToolUseID: 'toolu_bash_2',
      approvedToolName: 'Bash',
      networkToolUseID: 'toolu_network_1',
      expiredTokenCount: 0,
    });

    const matched = gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org', parent_tool_use_id: 'toolu_bash_2' },
      { toolUseID: 'toolu_network_2' },
    );
    expect(matched).toEqual({
      behavior: 'allow',
      updatedInput: {
        host: 'registry.npmjs.org',
        parent_tool_use_id: 'toolu_bash_2',
      },
    });
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed',
      parentToolUseID: 'toolu_bash_2',
      approvedToolName: 'Bash',
      networkToolUseID: 'toolu_network_2',
    });
  });

  it('denies expired tokens and records that pruning happened', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Bash',
      { command: 'npm test --runInBand' },
      { toolUseID: 'toolu_bash_1' },
    );
    now.value = 301_001;
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseID: 'toolu_network_1',
      expiredTokenCount: 1,
    });
  });

  it('prunes expired tokens and uses an explicitly matched unexpired token', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Bash',
      { command: 'npm test first' },
      { toolUseID: 'toolu_bash_expired' },
    );
    now.value = 301_001;
    gate.rememberAllowedTool(
      'Bash',
      { command: 'npm test second' },
      { toolUseID: 'toolu_bash_active' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org', parentToolUseID: 'toolu_bash_active' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('allow');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed',
      parentToolUseID: 'toolu_bash_active',
      approvedToolName: 'Bash',
      inputHash: sha256('{"command":"npm test second"}'),
      expiredTokenCount: 1,
    });
  });

  it('does not log raw host or command values', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Bash',
      { command: 'curl https://secret-host.example/path?token=abc123' },
      { toolUseID: 'toolu_bash_1' },
    );
    gate.decide(
      'SandboxNetworkAccess',
      { host: 'secret-host.example' },
      { toolUseID: 'toolu_network_1' },
    );

    const logText = JSON.stringify(vi.mocked(log).mock.calls);
    const outputText = JSON.stringify(vi.mocked(writeOutput).mock.calls);
    expect(logText).not.toContain('secret-host.example');
    expect(logText).not.toContain('curl https://secret-host.example');
    expect(outputText).not.toContain('secret-host.example');
    expect(outputText).not.toContain('curl https://secret-host.example');
  });
});
