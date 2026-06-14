import { spawn } from 'node:child_process';

import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';

import {
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '../../../../shared/tool-execution-policy-service.js';
import { NEUTRAL_CA_TRUST_ENV_KEYS } from '../../../../shared/neutral-ca-trust-env.js';
import {
  evaluateNeutralToolPreChecks,
  evaluateNeutralToolPolicy,
  LOCKED_ACCESS_PRESET_DENY_REASON,
} from '../../../../runner/tool-gate-core.js';
import {
  requestPermissionApprovalViaIpc,
  type PermissionIpcRuntimeEnv,
} from '../../../../runner/permission-ipc-client.js';
import type { ThirdPartyMcpGateConfig } from './third-party-mcp-gate.js';

// Gantry-owned shell tool for the DeepAgents lane. The model-visible tool is
// named `RunCommand` (the canonical public Gantry shell capability name) — NOT
// `execute`/`ls`/`read_file`/etc, which collide with deepagents' baked-in tool
// names (TOOL_NAME_COLLISION) and would bypass Gantry policy. We never use a
// deepagents execution backend (StateBackend + DENY_ALL_FILESYSTEM stay), so the
// command never touches deepagents' own permission model — every call is gated
// by Gantry's neutral tool gate and the durable permission IPC, then executed as
// a child of the already-sandboxed runner.
//
// The executor shapes the `{ command }` input into a `Bash`-named
// ToolExecutionPolicyService request so the first-class shell policy fires
// (protected-capability/mutation denials, scoped-RunCommand matching, and the
// request_access { kind: 'run_command' } recovery). The same gate the
// third-party MCP tools use applies, in the same order:
//   1. protected-capability / memory-boundary / yolo-denylist hard denials,
//   2. tool-execution policy evaluation against the agent's selected rules,
//   3. interactive-required -> requestPermissionApprovalViaIpc (the host writes
//      the durable pending_interactions row BEFORE the prompt renders),
//   4. deny -> return the deny string to the model (the command never runs).
//
// On allow the command runs via child_process.spawn as a child of the
// already-sandboxed runner, so it inherits the runner's OS sandbox confinement
// (protected-path write denies). Its env is a scrubbed allowlist (NOT inherited
// process.env) carrying the egress proxy + CA-trust keys so outbound traffic
// stays on the Gantry egress gateway, while the runner's IPC/provider secrets do
// not leak. Output is captured and truncated to a sane cap; the call honors a
// timeout / AbortSignal.

export const GANTRY_SHELL_TOOL_NAME = 'RunCommand';

// The policy/classifier key off the provider-native `Bash` tool name (see
// tool-execution-policy-service.ts and tool-rule-matcher.ts). We classify the
// gated request under this name so the existing shell logic fires; the
// model-visible tool name stays `RunCommand`.
const SHELL_POLICY_TOOL_NAME = 'Bash';

// Output cap returned to the model. Large command output is truncated with a
// trailing marker so the model knows the result was clipped.
const MAX_OUTPUT_CHARS = 16_000;

// Hard wall-clock cap for a single command. Mirrors a conservative interactive
// budget; the model can re-issue with a narrower command if it needs more.
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

// Network/proxy + CA-trust env keys the child must carry so egress stays on the
// Gantry egress gateway and TLS trust resolves — for EVERY client type, not just
// node. These are projected onto the runner's process.env by the host
// (buildToolNetworkEnv in shared/tool-network-env.ts sets the proxy/gRPC/CA keys;
// agent-spawn-helpers.ts sets GODEBUG=netdns=go for Go's resolver). The child env
// is an explicit allowlist (NOT inherited process.env) so these carry through
// while secrets do not. This MUST stay a superset of what buildToolNetworkEnv
// projects (a test asserts it) — the Claude lane's bash-trust-env.ts carries the
// same set; missing keys silently break egress for Go/gRPC/curl/git tools.
export const SHELL_CHILD_NETWORK_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'GRPC_PROXY',
  'grpc_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'GODEBUG',
  'GANTRY_EGRESS_PROXY_URL',
  'NODE_EXTRA_CA_CERTS',
  ...NEUTRAL_CA_TRUST_ENV_KEYS,
] as const;

// Minimal POSIX keys a shell needs to function. Only those actually set on
// process.env are copied (skip undefined).
const SHELL_CHILD_POSIX_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'USER',
  'SHELL',
  'TERM',
] as const;

// Secret-scrub: the model controls the command, so the child must NOT see the
// runner's IPC HMAC keys (GANTRY_IPC_AUTH_TOKEN/SECRET,
// GANTRY_MEMORY_IPC_AUTH_TOKEN) or any provider creds / gtw_ gateway tokens that
// live on process.env — a `printenv` would otherwise exfiltrate them and let the
// model forge IPC messages. Build a fresh env from an explicit allowlist of
// network/proxy + POSIX keys, copying ONLY set values, and pass that to spawn.
function buildShellChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    ...SHELL_CHILD_NETWORK_ENV_KEYS,
    ...SHELL_CHILD_POSIX_ENV_KEYS,
  ]) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

export interface GantryShellToolConfig {
  workspaceFolder: string;
  memoryBlock: string;
  configuredAllowedTools: readonly string[];
  gateContext: ThirdPartyMcpGateConfig['gateContext'];
  permissionEnv: PermissionIpcRuntimeEnv;
  lockedAccessPreset: boolean;
  // Working directory for the spawned command. Defaults to the runner cwd (the
  // sandboxed group workspace root) when omitted.
  cwd?: string;
  // Optional run-cancellation signal (the live-turn close sentinel aborts the
  // LangGraph stream; commands in flight are killed when it fires).
  signal?: AbortSignal;
}

const shellInputSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe('The shell command to run. Executed inside the Gantry sandbox.'),
});

export function createGantryShellTool(
  config: GantryShellToolConfig,
): StructuredToolInterface {
  const classifier = new ToolExecutionClassifier();
  const policy = new ToolExecutionPolicyService();

  const gatedFunc = async (input: { command: string }): Promise<string> => {
    const command = typeof input?.command === 'string' ? input.command : '';
    if (!command.trim()) {
      return 'RunCommand requires a non-empty command string.';
    }
    // Shape the input as a Bash policy request so the existing shell logic fires.
    const policyInput = { command };

    const preChecks = evaluateNeutralToolPreChecks({
      toolName: SHELL_POLICY_TOOL_NAME,
      toolInput: policyInput,
      memoryBlock: config.memoryBlock,
      yoloMode: config.gateContext.yoloMode,
    });
    if (preChecks) {
      return denyMessage(preChecks.reason);
    }

    const decision = evaluateNeutralToolPolicy({
      classifier,
      policy,
      toolName: SHELL_POLICY_TOOL_NAME,
      toolInput: policyInput,
      context: config.gateContext,
      allowedToolRules: config.configuredAllowedTools,
    });
    if (decision.status === 'allow') {
      return runShellCommand(command, config);
    }

    if (config.lockedAccessPreset) {
      return denyMessage(LOCKED_ACCESS_PRESET_DENY_REASON);
    }

    const approval = await requestPermissionApprovalViaIpc(
      config.permissionEnv,
      {
        appId: config.permissionEnv.appId,
        agentId: config.permissionEnv.agentId || undefined,
        agentFolder: config.workspaceFolder,
        targetJid: config.permissionEnv.chatJid || undefined,
        // Surface the canonical public capability name in the prompt, matching
        // how the host renders RunCommand approvals on the other lane.
        toolName: GANTRY_SHELL_TOOL_NAME,
        decisionReason: decision.reason,
        closestRule: decision.closestRule,
        toolInput: policyInput,
        threadId: config.gateContext.threadId,
      },
    );
    if (approval.approved) {
      return runShellCommand(command, config);
    }
    const reason = approval.reason || 'Denied by operator';
    return denyMessage(`Permission denied: ${reason}`);
  };

  return tool(gatedFunc, {
    name: GANTRY_SHELL_TOOL_NAME,
    description:
      'Run a shell command inside the Gantry sandbox. Every call is policy-gated and may require per-call human approval. Output is truncated.',
    schema: shellInputSchema as never,
  }) as unknown as StructuredToolInterface;
}

// Executes the approved command as a child of the already-sandboxed runner. The
// child inherits the OS sandbox confinement (protected-path write denies) from
// being a runner child; its env is a scrubbed allowlist (buildShellChildEnv) so
// the runner's egress-proxy env carries through — egress stays on the Gantry
// egress gateway — but the IPC HMAC keys and provider creds do NOT leak to the
// model-controlled command. Uses a shell so the model can use pipes/globs the
// policy matched against; the OS sandbox is the enforcement boundary, not argv
// shape.
async function runShellCommand(
  command: string,
  config: GantryShellToolConfig,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: config.cwd,
      env: buildShellChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      config.signal?.removeEventListener('abort', onAbort);
      resolve(text);
    };

    const onAbort = () => {
      child.kill('SIGKILL');
      finish(
        formatResult({
          stdout,
          stderr,
          exitNote: 'Command aborted (run stopped).',
        }),
      );
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(
        formatResult({
          stdout,
          stderr,
          exitNote: `Command timed out after ${DEFAULT_COMMAND_TIMEOUT_MS}ms and was killed.`,
        }),
      );
    }, DEFAULT_COMMAND_TIMEOUT_MS);

    if (config.signal) {
      if (config.signal.aborted) {
        onAbort();
        return;
      }
      config.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += chunk.toString();
    });
    child.on('error', (err) => {
      finish(
        formatResult({
          stdout,
          stderr,
          exitNote: `Failed to start command: ${err.message}`,
        }),
      );
    });
    child.on('close', (code, signalName) => {
      const exitNote = signalName
        ? `Command terminated by signal ${signalName}.`
        : `Command exited with code ${code ?? 'null'}.`;
      finish(formatResult({ stdout, stderr, exitNote }));
    });
  });
}

function formatResult(input: {
  stdout: string;
  stderr: string;
  exitNote: string;
}): string {
  const parts: string[] = [input.exitNote];
  if (input.stdout.trim()) {
    parts.push(`--- stdout ---\n${truncate(input.stdout)}`);
  }
  if (input.stderr.trim()) {
    parts.push(`--- stderr ---\n${truncate(input.stderr)}`);
  }
  return parts.join('\n');
}

function truncate(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated ${value.length - MAX_OUTPUT_CHARS} more characters]`;
}

function denyMessage(reason: string): string {
  // Returned as the tool result string so the model sees the denial as a tool
  // error and can recover, matching the third-party MCP gate's deny-to-model copy.
  return reason;
}
