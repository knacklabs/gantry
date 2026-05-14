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

  it('allows one SDK network prompt for one approved Bash tool use', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Bash',
      { command: 'npm test --runInBand' },
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
      bashToolUseID: 'toolu_bash_1',
      hostHash: sha256('registry.npmjs.org'),
      commandHash: sha256('npm test --runInBand'),
      tokenCreatedAtMs: 1_000,
      tokenExpiresAtMs: 301_000,
      tokenTtlMs: 300_000,
    });
  });

  it('allows repeated SDK network prompts for the same recent Bash approval', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Bash',
      { cmd: 'npm test --runInBand' },
      { toolUseID: 'toolu_bash_1' },
    );
    gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org' },
      { toolUseID: 'toolu_network_1' },
    );
    const second = gate.decide(
      'SandboxNetworkAccess',
      { host: 'example.com' },
      { toolUseID: 'toolu_network_2' },
    );

    expect(second).toEqual({
      behavior: 'allow',
      updatedInput: { host: 'example.com' },
    });
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed',
      networkToolUseID: 'toolu_network_2',
      bashToolUseID: 'toolu_bash_1',
      hostHash: sha256('example.com'),
      expiredTokenCount: 0,
    });
  });

  it('does not mint a network token without a Bash tool-use id and command', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool('Bash', { command: 'npm test' }, {});
    gate.rememberAllowedTool(
      'Bash',
      { command: '' },
      { toolUseID: 'toolu_bash_blank' },
    );
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

  it('denies network prompts without a parent id when multiple Bash approvals are active', () => {
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
    expect(ambiguous?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
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
      bashToolUseID: 'toolu_bash_2',
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

  it('prunes expired tokens and consumes the oldest unexpired token', () => {
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
      { host: 'registry.npmjs.org' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('allow');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed',
      bashToolUseID: 'toolu_bash_active',
      commandHash: sha256('npm test second'),
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
