import os from 'node:os';

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
  lockedAccessPreset?: boolean;
  signal?: AbortSignal;
}) {
  return createGantryShellTool({
    workspaceFolder: 'group',
    memoryBlock: '',
    configuredAllowedTools: overrides?.rules ?? [],
    gateContext: { conversationId: 'tg:group' },
    permissionEnv: PERMISSION_ENV,
    lockedAccessPreset: overrides?.lockedAccessPreset ?? false,
    cwd: os.tmpdir(),
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
    requestPermissionApprovalViaIpc.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is named RunCommand (never execute) so it does not collide with deepagents tools', () => {
    expect(GANTRY_SHELL_TOOL_NAME).toBe('RunCommand');
    expect(makeTool().name).toBe('RunCommand');
  });

  it('executes when a scoped RunCommand rule allows the command — no permission prompt', async () => {
    const tool = makeTool({ rules: ['RunCommand(echo *)'] });
    const result = await invoke(tool, 'echo hello-gantry');
    expect(requestPermissionApprovalViaIpc).not.toHaveBeenCalled();
    expect(result).toContain('hello-gantry');
    expect(result).toContain('exited with code 0');
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
    const tool = makeTool({ rules: [], lockedAccessPreset: true });
    const result = await invoke(tool, 'echo locked');
    expect(requestPermissionApprovalViaIpc).not.toHaveBeenCalled();
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

  it('captures stderr and a non-zero exit code (operator-approved command)', async () => {
    // A multi-statement command needs operator approval (it is not coverable by a
    // single scoped rule); the approved path still captures stderr + exit code.
    requestPermissionApprovalViaIpc.mockResolvedValue({ approved: true });
    const tool = makeTool({ rules: [] });
    const result = await invoke(tool, 'echo oops 1>&2; exit 3');
    expect(result).toContain('oops');
    expect(result).toContain('exited with code 3');
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

  it('passes the runner proxy env so egress is proxied (child sees HTTP_PROXY)', async () => {
    const previous = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = 'http://127.0.0.1:18080/';
    requestPermissionApprovalViaIpc.mockResolvedValue({ approved: true });
    try {
      const tool = makeTool({ rules: [] });
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
