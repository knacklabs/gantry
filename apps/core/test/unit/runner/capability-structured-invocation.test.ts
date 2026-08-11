import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

// The MCP tool module resolves GANTRY_IPC_DIR at import; set it before the
// (hoisted) tool import so the module graph loads under test.
vi.hoisted(() => {
  process.env.GANTRY_IPC_DIR =
    process.env.GANTRY_IPC_DIR ?? '/tmp/gantry-clirun-test-ipc';
});

import { runStructuredLocalCliCapability } from '@core/jobs/structured-local-cli-invocation.js';
import { registerCapabilityRunTool } from '@agent-runner-src/mcp/tools/capability-run.js';
import {
  BASELINE_GANTRY_MCP_TOOL_NAMES,
  DURABLE_GRANT_EXCLUDED_DISPATCHERS,
  HOST_AUTHORIZED_MCP_PROXY_DISPATCHERS,
} from '@core/shared/admin-mcp-tools.js';
import {
  buildLocalCliSemanticCapability,
  semanticCapabilityInputSchema,
} from '@core/shared/semantic-capabilities.js';
import {
  CAPABILITY_RUN_MAX_ARGS,
  CAPABILITY_RUN_MAX_ARG_BYTES,
  CAPABILITY_RUN_MAX_TOTAL_ARG_BYTES,
  CAPABILITY_RUN_OUTPUT_MAX_BYTES,
} from '@core/shared/structured-local-cli.js';
import type {
  RunnerSandboxProvider,
  RunnerSandboxSpawnInput,
} from '@core/shared/runner-sandbox-provider.js';

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
};

const tempDirs: string[] = [];

function executableFixture(): { executable: string; hash: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-capability-run-'));
  tempDirs.push(dir);
  const executable = path.join(dir, 'acme');
  const content = '#!/bin/sh\nexit 0\n';
  fs.writeFileSync(executable, content, { mode: 0o700 });
  const hash = createHash('sha256').update(content).digest('hex');
  return { executable, hash: `sha256:${hash}` };
}

function repository(input: {
  executable: string;
  hash: string;
  templates?: string[];
  personId?: string | null;
}) {
  const capability = buildLocalCliSemanticCapability({
    capabilityId: 'acme.records.read',
    displayName: 'Acme records read',
    category: 'Acme',
    risk: 'read',
    can: 'Read reviewed Acme records.',
    cannot: 'Write records or change CLI configuration.',
    executablePath: input.executable,
    executableVersion: '1.0.0',
    executableHash: input.hash,
    commandTemplates: input.templates ?? [
      `${input.executable} records read fixed`,
      `${input.executable} records list *`,
    ],
    authPreflightCommand: `${input.executable} auth status`,
  });
  return {
    listAgentToolBindings: vi.fn(async () => [
      {
        status: 'active',
        toolId: 'tool:capability:acme.records.read',
        personId: input.personId ?? null,
      },
    ]),
    getTool: vi.fn(async () => ({
      appId: 'app:test',
      name: 'capability:acme.records.read',
      inputSchema: semanticCapabilityInputSchema(capability),
    })),
  };
}

function fakeProvider(): {
  provider: RunnerSandboxProvider;
  child: FakeChild;
  start: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 999_999;
  child.kill = vi.fn(() => true);
  const start = vi.fn((_input: RunnerSandboxSpawnInput) => child as never);
  return {
    child,
    start,
    provider: { id: 'sandbox_runtime', enforcing: true, start },
  };
}

function invocation(input: {
  repository: ReturnType<typeof repository>;
  provider?: RunnerSandboxProvider;
  args: string[];
  personId?: string;
  signal?: AbortSignal;
  cwd?: string;
}) {
  return runStructuredLocalCliCapability({
    repository: input.repository as never,
    appId: 'app:test',
    agentId: 'agent:test',
    personId: input.personId,
    capabilityId: 'acme.records.read',
    args: input.args,
    cwd: input.cwd ?? process.cwd(),
    env: { PATH: '/usr/bin', HOME: os.homedir() },
    runnerSandboxProvider: input.provider ?? fakeProvider().provider,
    signal: input.signal ?? new AbortController().signal,
    conversationId: 'sl:C123',
    threadId: 'thread-1',
    runId: 'run-1',
  });
}

describe('CLIRUN-1-1', () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('structured local_cli invocation validates argv, verifies executable, bounds output', async () => {
    const register = vi.fn();
    registerCapabilityRunTool({ tool: register } as never);
    expect(register.mock.calls[0]?.[0]).toBe('capability_run');
    expect(BASELINE_GANTRY_MCP_TOOL_NAMES).toContain('capability_run');
    expect(DURABLE_GRANT_EXCLUDED_DISPATCHERS).toContain('capability_run');
    expect(HOST_AUTHORIZED_MCP_PROXY_DISPATCHERS).toContain('capability_run');

    vi.useFakeTimers();
    const fixture = executableFixture();
    const tools = repository(fixture);
    const { provider, child, start } = fakeProvider();
    const resultPromise = invocation({
      repository: tools,
      provider,
      args: ['records', 'list', 'customer-42'],
    });

    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const sandboxInput = start.mock.calls[0]?.[0] as RunnerSandboxSpawnInput;
    // TOCTOU-safe: the sandbox runs the executable IN PLACE (its resolved real
    // path, so launchers/native binaries keep their runtime context), and that
    // real file hashes to the reviewed hash. Immutability is enforced by the
    // realpath being outside the workspace and not group/other-writable.
    expect(sandboxInput.command).toBe(fs.realpathSync(fixture.executable));
    expect(
      `sha256:${createHash('sha256').update(fs.readFileSync(sandboxInput.command)).digest('hex')}`,
    ).toBe(fixture.hash);
    expect(sandboxInput.args).toEqual(['records', 'list', 'customer-42']);
    expect(sandboxInput.env).not.toHaveProperty('GANTRY_ASYNC_COMMAND_SCRIPT');
    child.stdout.write(
      `discarded-${'x'.repeat(CAPABILITY_RUN_OUTPUT_MAX_BYTES)}`,
    );
    child.stderr.write('warning');
    child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toEqual({
      stdout: 'x'.repeat(CAPABILITY_RUN_OUTPUT_MAX_BYTES),
      stderr: 'warning',
    });

    await expect(
      invocation({ repository: tools, args: ['records', 'write', 'fixed'] }),
    ).rejects.toMatchObject({ code: 'invalid_args' });
    await expect(
      invocation({
        repository: tools,
        args: ['records', 'list', '--config', '/tmp/other'],
      }),
    ).rejects.toMatchObject({ code: 'invalid_args' });
    await expect(
      invocation({
        repository: tools,
        args: ['records', 'read', 'fixed', 'excess'],
      }),
    ).rejects.toMatchObject({ code: 'invalid_args' });

    for (const args of [
      ['records', 'list', 'bad\0value'],
      ['x'.repeat(CAPABILITY_RUN_MAX_ARG_BYTES + 1)],
      Array.from({ length: CAPABILITY_RUN_MAX_ARGS + 1 }, () => 'x'),
      Array.from({ length: 5 }, () =>
        'x'.repeat(CAPABILITY_RUN_MAX_TOTAL_ARG_BYTES / 4),
      ),
    ]) {
      await expect(
        invocation({ repository: tools, args }),
      ).rejects.toMatchObject({ code: 'invalid_args' });
    }

    await expect(
      invocation({
        repository: repository({
          ...fixture,
          hash: `sha256:${'0'.repeat(64)}`,
        }),
        args: ['records', 'read', 'fixed'],
      }),
    ).rejects.toMatchObject({ code: 'executable_identity_mismatch' });

    await expect(
      invocation({
        repository: repository({ ...fixture, personId: 'person:other' }),
        args: ['records', 'read', 'fixed'],
        personId: 'person:caller',
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });

    // A group/other-writable executable can be swapped after verification, so
    // it cannot be pinned.
    const writable = executableFixture();
    fs.chmodSync(writable.executable, 0o777);
    await expect(
      invocation({
        repository: repository(writable),
        args: ['records', 'read', 'fixed'],
      }),
    ).rejects.toMatchObject({ code: 'executable_identity_mismatch' });

    // An executable under the agent-writable workspace can be swapped, so it is
    // rejected even with a matching hash.
    const inWorkspace = executableFixture();
    await expect(
      invocation({
        repository: repository(inWorkspace),
        args: ['records', 'read', 'fixed'],
        cwd: path.dirname(inWorkspace.executable),
      }),
    ).rejects.toMatchObject({ code: 'executable_identity_mismatch' });

    // Deadline already fired during setup: the command must NOT spawn (a
    // retried mutating capability cannot double-apply side effects).
    const expired = fakeProvider();
    const fired = new AbortController();
    fired.abort();
    await expect(
      invocation({
        repository: tools,
        args: ['records', 'read', 'fixed'],
        provider: expired.provider,
        signal: fired.signal,
      }),
    ).rejects.toThrow();
    expect(expired.start).not.toHaveBeenCalled();
  });
});
