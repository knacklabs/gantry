import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PermissionIpcRuntimeEnv } from '@core/runner/permission-ipc-client.js';

// The permission-IPC client is mocked so we can drive approve/deny without the
// host. The shell tool is the unit under test; its gate flow (preChecks ->
// policy -> permission IPC -> execute) is exercised end to end against a real
// /bin/sh child for the allow path.
const requestPermissionApprovalViaIpc = vi.fn();
vi.mock('@core/runner/permission-ipc-client.js', () => ({
  requestPermissionApprovalViaIpc: (...args: unknown[]) =>
    requestPermissionApprovalViaIpc(...args),
}));

import {
  createGantryShellTool,
  GANTRY_SHELL_TOOL_NAME,
  SHELL_CHILD_NETWORK_ENV_KEYS,
} from '@core/adapters/llm/deepagents-langchain/runner/gantry-shell-tool.js';
import type { DeepAgentsPermissionDenial } from '@core/adapters/llm/deepagents-langchain/runner/third-party-mcp-gate.js';
import { buildToolNetworkEnv } from '@core/shared/tool-network-env.js';

const PERMISSION_ENV: PermissionIpcRuntimeEnv = {
  appId: 'default',
  agentId: 'agent:main',
  chatJid: 'tg:group',
  jobId: '',
  jobName: '',
  jobRunId: '',
  jobRunLeaseToken: '',
  jobRunLeaseFencingVersion: '',
  ipcAuthToken: 'tok',
  ipcResponseVerifyKey: '',
  ipcResponseKeyId: 'kid',
  permissionRequestTimeoutMs: 1000,
  resolveWorkspaceIpcDir: (folder: string) => `/tmp/ipc/${folder}`,
};

function makeTool(overrides?: {
  rules?: string[];
  capabilityRequestToolsHidden?: boolean;
  onPermissionDenied?: (input: DeepAgentsPermissionDenial) => never;
  signal?: AbortSignal;
  toolNetworkEnv?: Record<string, string>;
  cwd?: string;
  scheduled?: boolean;
}) {
  return createGantryShellTool({
    workspaceFolder: 'group',
    memoryBlock: '',
    configuredAllowedTools: overrides?.rules ?? [],
    gateContext: {
      conversationId: 'tg:group',
      ...(overrides?.scheduled ? { isScheduledJob: true, jobId: 'job:ats' } : {}),
    },
    permissionEnv: PERMISSION_ENV,
    capabilityRequestToolsHidden:
      overrides?.capabilityRequestToolsHidden ?? false,
    ...(overrides?.onPermissionDenied
      ? { onPermissionDenied: overrides.onPermissionDenied }
      : {}),
    cwd: overrides?.cwd ?? os.tmpdir(),
    toolNetworkEnv: overrides?.toolNetworkEnv,
    ...(overrides?.signal ? { signal: overrides.signal } : {}),
  });
}

async function invoke(
  tool: ReturnType<typeof createGantryShellTool>,
  command: string,
): Promise<string> {
  const result = await tool.invoke({ command } as never);
  return typeof result === 'string' ? result : JSON.stringify(result);
}

describe('Gantry DeepAgents shell tool', () => {
  beforeEach(() => {
    requestPermissionApprovalViaIpc
      .mockReset()
      .mockResolvedValue({ approved: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is named RunCommand (never execute) so it does not collide with deepagents tools', () => {
    expect(GANTRY_SHELL_TOOL_NAME).toBe('RunCommand');
    expect(makeTool().name).toBe('RunCommand');
  });

  it('executes an interactively-approved scoped RunCommand rule without IPC', async () => {
    const tool = makeTool({ rules: ['RunCommand(echo *)'] });
    const result = await invoke(tool, 'echo hello-gantry');
    expect(requestPermissionApprovalViaIpc).not.toHaveBeenCalled();
    expect(result).toContain('hello-gantry');
    expect(result).toContain('exited with code 0');
  });

  it('starts a reviewed ATS Cutshort skill locally for a scheduled job without prompting', async () => {
    // This is the local deterministic equivalent of the source-sync job: the
    // exact reviewed command is executed from the agent workspace, rather than
    // merely being accepted by a matcher. The real worker can then replace this
    // harmless fixture and connect to Chrome/CDP in Dev.
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-ats-source-sync-'),
    );
    const workerPath = path.join(
      workspace,
      'skills/ats-skills/scripts/cutshort-worker.mjs',
    );
    try {
      fs.mkdirSync(path.dirname(workerPath), { recursive: true });
      fs.writeFileSync(
        workerPath,
        '#!/usr/bin/env node\nconsole.log(`scraping started: ${process.argv[2]}`);\n',
        { mode: 0o755 },
      );

      const tool = makeTool({
        cwd: workspace,
        scheduled: true,
        rules: [
          'RunCommand(skills/ats-skills/scripts/cutshort-worker.mjs sync)',
        ],
      });
      const result = await invoke(
        tool,
        'skills/ats-skills/scripts/cutshort-worker.mjs sync',
      );

      expect(requestPermissionApprovalViaIpc).not.toHaveBeenCalled();
      expect(result).toContain('scraping started: sync');
      expect(result).toContain('exited with code 0');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('still denies an unreviewed protected skill command without prompting', async () => {
    const tool = makeTool({
      scheduled: true,
      rules: ['RunCommand(echo *)'],
    });
    const result = await invoke(
      tool,
      'skills/ats-skills/scripts/cutshort-worker.mjs sync',
    );

    expect(requestPermissionApprovalViaIpc).not.toHaveBeenCalled();
    expect(result).toContain('not on autonomous run allowlist');
    expect(result).not.toContain('exited with code 0');
  });

  it('prompts via the durable permission IPC when no rule matches; denied -> NOT executed', async () => {
    requestPermissionApprovalViaIpc.mockResolvedValue({
      approved: false,
      reason: 'operator said no',
    });
    const tool = makeTool({ rules: [] });
    const result = await invoke(tool, 'echo should-not-run');
    expect(requestPermissionApprovalViaIpc).toHaveBeenCalledTimes(1);
    // The gate denied: the model gets the deny copy, the command never ran (no
    // stdout block, no exit-code line).
    expect(result).toContain('Permission denied');
    expect(result).not.toContain('should-not-run');
    expect(result).not.toContain('exited with code');
  });

  it('terminates a scheduled denial instead of returning it to the model', async () => {
    requestPermissionApprovalViaIpc.mockResolvedValue({
      approved: false,
      reason: 'Unattended jobs do not wait for approval.',
    });
    const onPermissionDenied = vi.fn(
      ({ toolName, reason }: DeepAgentsPermissionDenial): never => {
        throw new Error(`${toolName}: ${reason}`);
      },
    );
    const tool = makeTool({ onPermissionDenied });

    await expect(invoke(tool, 'echo should-not-run')).rejects.toThrow(
      'RunCommand: Unattended jobs do not wait for approval.',
    );
    expect(onPermissionDenied).toHaveBeenCalledWith({
      toolName: 'RunCommand',
      reason: 'Unattended jobs do not wait for approval.',
      grantable: true,
      recoveryAction: expect.stringMatching(/^request_access /),
    });
  });

  it('passes the command through as a Bash policy request to the permission prompt', async () => {
    requestPermissionApprovalViaIpc.mockResolvedValue({
      approved: false,
      reason: 'no',
    });
    const tool = makeTool({ rules: [] });
    await invoke(tool, 'ls -la /etc');
    const options = requestPermissionApprovalViaIpc.mock.calls[0]?.[1] as {
      toolName: string;
      toolInput: { command: string };
    };
    // The model-visible/prompt tool name is the canonical RunCommand, and the
    // command is forwarded as the gated tool input.
    expect(options.toolName).toBe('RunCommand');
    expect(options.toolInput).toEqual({ command: 'ls -la /etc' });
  });

  it('executes after the operator approves an unmatched command', async () => {
    requestPermissionApprovalViaIpc.mockResolvedValue({ approved: true });
    const tool = makeTool({ rules: [] });
    const result = await invoke(tool, 'echo approved-path');
    expect(requestPermissionApprovalViaIpc).toHaveBeenCalledTimes(1);
    expect(result).toContain('approved-path');
    expect(result).toContain('exited with code 0');
  });

  it('denies hard when the agent runs under a locked access preset (no prompt)', async () => {
    requestPermissionApprovalViaIpc.mockResolvedValue({
      approved: false,
      reason: 'locked access preset',
    });
    const tool = makeTool({
      rules: [],
      capabilityRequestToolsHidden: true,
    });
    const result = await invoke(tool, 'echo locked');
    expect(requestPermissionApprovalViaIpc).toHaveBeenCalledTimes(1);
    expect(result).toContain('locked access preset');
    expect(result).not.toContain('exited with code');
  });

  it('hard-denies a protected-capability mutation before any prompt (memory/settings boundary)', async () => {
    // A command that mutates a protected capability path is denied by the
    // pre-checks (protected-capability), never reaching the permission prompt.
    const tool = makeTool({ rules: [] });
    const result = await invoke(tool, 'echo pwned > ~/.gantry/settings.yaml');
    expect(requestPermissionApprovalViaIpc).not.toHaveBeenCalled();
    expect(result.toLowerCase()).toContain('protected');
    expect(result).not.toContain('exited with code');
  });

  it('routes a scheduled-run protected-capability pre-check denial through the terminal handler', async () => {
    // On a scheduled run (onPermissionDenied present) a pre-check denial must
    // terminate the turn as a non-grantable instruction, not return an ordinary
    // tool message the model could ignore and work around.
    let captured: DeepAgentsPermissionDenial | undefined;
    const tool = makeTool({
      rules: [],
      onPermissionDenied: (denial): never => {
        captured = denial;
        throw new Error('terminal');
      },
    });

    await expect(
      invoke(tool, 'echo pwned > ~/.gantry/settings.yaml'),
    ).rejects.toThrow('terminal');
    expect(requestPermissionApprovalViaIpc).not.toHaveBeenCalled();
    expect(captured).toMatchObject({
      toolName: 'RunCommand',
      grantable: false,
    });
    expect(captured?.reason.toLowerCase()).toContain('protected');
  });

  it('returns a structured error with unchanged output for a non-zero exit', async () => {
    // A multi-statement command needs operator approval (it is not coverable by a
    // single scoped rule); the approved path still captures stderr + exit code.
    requestPermissionApprovalViaIpc.mockResolvedValue({ approved: true });
    const tool = makeTool({ rules: [] });
    const result = await tool.invoke({
      command: 'echo oops 1>&2; exit 3',
    } as never);
    const output = 'Command exited with code 3.\n--- stderr ---\noops\n';
    expect(result).toEqual({
      content: [{ type: 'text', text: output }],
      isError: true,
      error: {
        category: 'business',
        isRetryable: false,
        message: output,
      },
    });
  });

  it('aborts a long command when the run signal fires', async () => {
    requestPermissionApprovalViaIpc.mockResolvedValue({ approved: true });
    const controller = new AbortController();
    const tool = makeTool({
      rules: [],
      signal: controller.signal,
    });
    const pending = invoke(tool, 'sleep 30');
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result).toContain('aborted');
    expect(result).not.toContain('exited with code 0');
  });

  it('throws without launching or prompting when the run signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = makeTool({
      rules: ['RunCommand(echo *)'],
      signal: controller.signal,
    });

    // An already-aborted turn must not launch the command or even request
    // approval — it throws the abort so the graph tears the turn down, matching
    // the facade/third-party MCP wrappers.
    await expect(invoke(tool, 'echo should-not-run')).rejects.toThrow();
    expect(requestPermissionApprovalViaIpc).not.toHaveBeenCalled();
  });

  it('does not launch the shell command when a sibling denial aborts the turn during approval', async () => {
    const controller = new AbortController();
    const marker = path.join(
      os.tmpdir(),
      `gantry-shell-siblingabort-${Date.now()}-${Math.random()}.txt`,
    );
    // Approval resolves, but a parallel tool call was denied while it was
    // pending and aborted the terminal-turn signal first.
    requestPermissionApprovalViaIpc.mockImplementation(async () => {
      controller.abort();
      return { approved: true };
    });
    const tool = makeTool({ rules: [], signal: controller.signal });

    await expect(
      invoke(tool, `echo leaked > ${shellQuote(marker)}`),
    ).rejects.toThrow();
    // The post-approval fence prevents the side effect entirely.
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('kills the full shell process group on abort so background children do not outlive the command', async () => {
    requestPermissionApprovalViaIpc.mockResolvedValue({ approved: true });
    const controller = new AbortController();
    const marker = path.join(
      os.tmpdir(),
      `gantry-shell-grandchild-${Date.now()}-${Math.random()}.txt`,
    );
    const tool = makeTool({
      rules: [],
      signal: controller.signal,
    });
    const pending = invoke(
      tool,
      `(sleep 0.3; echo leaked > ${shellQuote(marker)}) & wait`,
    );
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(result).toContain('aborted');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('documents the network/proxy env keys the sandboxed child receives', () => {
    // The child env is a scrubbed allowlist that includes these proxy/CA keys
    // (agent-spawn populates them on the runner) so egress stays on the gateway —
    // for non-node tools (curl/git CA trust) and Go/gRPC clients too.
    expect(SHELL_CHILD_NETWORK_ENV_KEYS).toContain('HTTP_PROXY');
    expect(SHELL_CHILD_NETWORK_ENV_KEYS).toContain('HTTPS_PROXY');
    expect(SHELL_CHILD_NETWORK_ENV_KEYS).toContain('GANTRY_EGRESS_PROXY_URL');
    expect(SHELL_CHILD_NETWORK_ENV_KEYS).toContain('GRPC_PROXY');
    expect(SHELL_CHILD_NETWORK_ENV_KEYS).toContain('NODE_USE_ENV_PROXY');
    expect(SHELL_CHILD_NETWORK_ENV_KEYS).toContain('GODEBUG');
    // Non-node CA-trust aliases (curl/git/python/etc).
    expect(SHELL_CHILD_NETWORK_ENV_KEYS).toContain('SSL_CERT_FILE');
    expect(SHELL_CHILD_NETWORK_ENV_KEYS).toContain('CURL_CA_BUNDLE');
  });

  it('stays a superset of every key buildToolNetworkEnv projects (drift guard)', () => {
    // The runner's proxy/CA env is built by buildToolNetworkEnv; the shell child
    // allowlist must carry every key it sets, or egress silently breaks for the
    // dropped key. This guard fails if a new proxy/CA key is added there without
    // being added to the allowlist (the exact drift that broke Go/gRPC egress).
    const projected = buildToolNetworkEnv({
      proxyUrl: 'http://127.0.0.1:18080/',
      caBundlePath: '/tmp/ca.pem',
      noProxy: { NO_PROXY: 'localhost', no_proxy: 'localhost' },
    });
    const allowlist = new Set<string>(SHELL_CHILD_NETWORK_ENV_KEYS);
    const missing = Object.keys(projected).filter((key) => !allowlist.has(key));
    expect(missing).toEqual([]);
  });

  it('passes explicit tool network env so egress is proxied (child sees HTTP_PROXY)', async () => {
    const previous = process.env.HTTP_PROXY;
    delete process.env.HTTP_PROXY;
    requestPermissionApprovalViaIpc.mockResolvedValue({ approved: true });
    try {
      const tool = makeTool({
        rules: [],
        toolNetworkEnv: {
          HTTP_PROXY: 'http://127.0.0.1:18080/',
        },
      });
      const result = await invoke(tool, 'printf %s "$HTTP_PROXY"');
      expect(result).toContain('http://127.0.0.1:18080/');
    } finally {
      if (previous === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = previous;
    }
  });

  it('scrubs IPC HMAC secrets from the model-controlled child env', async () => {
    // The child env is a scrubbed allowlist, not inherited process.env, so the
    // model cannot `printenv` the runner's IPC tokens/secrets and forge IPC.
    const priorToken = process.env.GANTRY_IPC_AUTH_TOKEN;
    const priorMemToken = process.env.GANTRY_MEMORY_IPC_AUTH_TOKEN;
    const priorSecret = process.env.GANTRY_IPC_AUTH_SECRET;
    process.env.GANTRY_IPC_AUTH_TOKEN = 'ipc-token-secret';
    process.env.GANTRY_MEMORY_IPC_AUTH_TOKEN = 'mem-ipc-token-secret';
    process.env.GANTRY_IPC_AUTH_SECRET = 'ipc-hmac-secret';
    requestPermissionApprovalViaIpc.mockResolvedValue({ approved: true });
    try {
      const tool = makeTool({ rules: [] });
      const result = await invoke(
        tool,
        'printf "%s|%s|%s" "$GANTRY_IPC_AUTH_TOKEN" "$GANTRY_MEMORY_IPC_AUTH_TOKEN" "$GANTRY_IPC_AUTH_SECRET"',
      );
      expect(result).not.toContain('ipc-token-secret');
      expect(result).not.toContain('mem-ipc-token-secret');
      expect(result).not.toContain('ipc-hmac-secret');
      // The vars resolve to empty in the child (the allowlist excluded them).
      expect(result).toContain('|');
    } finally {
      restoreEnv('GANTRY_IPC_AUTH_TOKEN', priorToken);
      restoreEnv('GANTRY_MEMORY_IPC_AUTH_TOKEN', priorMemToken);
      restoreEnv('GANTRY_IPC_AUTH_SECRET', priorSecret);
    }
  });
});

function restoreEnv(key: string, prior: string | undefined): void {
  if (prior === undefined) delete process.env[key];
  else process.env[key] = prior;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
