import { createHash } from 'node:crypto';

import {
  SDK_SANDBOX_NETWORK_ACCESS_TOOL_NAME,
  isSdkSandboxNetworkAccessToolName,
} from '../../shared/agent-tool-references.js';
import { log } from './logging.js';
import { writeOutput } from './output.js';
import { sandboxBlockedRuntimeEvents } from './sandbox-events.js';
import type { AgentRunnerInput } from './types.js';

export interface SdkSandboxNetworkGate {
  rememberAllowedTool(
    toolName: string,
    input: Record<string, unknown>,
    permissionOpts: { toolUseID?: string },
  ): void;
  decide(
    toolName: string,
    input: Record<string, unknown>,
    permissionOpts: { toolUseID?: string; parentToolUseID?: string },
  ):
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string; interrupt: false }
    | null;
}

interface SdkSandboxNetworkApprovalToken {
  bashToolUseID?: string;
  commandHash: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface SdkSandboxNetworkGateOptions {
  ttlMs?: number;
  nowMs?: () => number;
}

const DEFAULT_SANDBOX_NETWORK_TOKEN_TTL_MS = 300_000;

export function createSdkSandboxNetworkGate(
  agentInput: AgentRunnerInput,
  options: SdkSandboxNetworkGateOptions = {},
): SdkSandboxNetworkGate {
  const ttlMs = options.ttlMs ?? DEFAULT_SANDBOX_NETWORK_TOKEN_TTL_MS;
  const nowMs = options.nowMs ?? Date.now;
  const tokens: SdkSandboxNetworkApprovalToken[] = [];

  function writeEvent(input: {
    decision: string;
    reason: string;
    networkToolUseID?: string;
    bashToolUseID?: string;
    hostHash?: string;
    commandHash?: string;
    tokenCreatedAtMs?: number;
    tokenExpiresAtMs?: number;
    tokenTtlMs?: number;
    expiredTokenCount?: number;
  }): void {
    const payload: Record<string, unknown> = {
      toolName: SDK_SANDBOX_NETWORK_ACCESS_TOOL_NAME,
      canonicalCapability: 'Bash',
      decision: input.decision,
      reason: input.reason,
      tokenTtlMs: input.tokenTtlMs ?? ttlMs,
      ...(input.networkToolUseID
        ? { networkToolUseID: input.networkToolUseID }
        : {}),
      ...(input.bashToolUseID ? { bashToolUseID: input.bashToolUseID } : {}),
      ...(input.hostHash ? { hostHash: input.hostHash } : {}),
      ...(input.commandHash ? { commandHash: input.commandHash } : {}),
      ...(input.tokenCreatedAtMs !== undefined
        ? { tokenCreatedAtMs: input.tokenCreatedAtMs }
        : {}),
      ...(input.tokenExpiresAtMs !== undefined
        ? { tokenExpiresAtMs: input.tokenExpiresAtMs }
        : {}),
      ...(input.expiredTokenCount !== undefined
        ? { expiredTokenCount: input.expiredTokenCount }
        : {}),
    };
    log(`Sandbox network decision ${JSON.stringify(payload)}`);
    writeOutput({
      status: 'success',
      result: null,
      runtimeEvents: sandboxBlockedRuntimeEvents(agentInput, payload),
    });
  }

  function pruneExpiredTokens(now: number): number {
    let expired = 0;
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      const token = tokens[index];
      if (!token) {
        tokens.splice(index, 1);
        continue;
      }
      if (token.expiresAtMs <= now) {
        tokens.splice(index, 1);
        expired += 1;
      }
    }
    return expired;
  }

  return {
    rememberAllowedTool(toolName, input, permissionOpts) {
      if (toolName !== 'Bash') return;
      const bashToolUseID = permissionOpts.toolUseID?.trim();
      const command = readBashCommand(input)?.trim();
      if (!bashToolUseID || !command) {
        writeEvent({
          decision: 'sdk_network_gate_token_rejected',
          reason:
            'MyClaw did not mint a sandbox network token because Bash tool-use id or command was missing.',
        });
        return;
      }
      const createdAtMs = nowMs();
      tokens.push({
        bashToolUseID,
        commandHash: hashString(command),
        createdAtMs,
        expiresAtMs: createdAtMs + ttlMs,
      });
    },
    decide(toolName, input, permissionOpts) {
      if (!isSdkSandboxNetworkAccessToolName(toolName)) return null;

      const hostHash = sandboxNetworkHostHash(input);
      const now = nowMs();
      const expiredTokenCount = pruneExpiredTokens(now);
      const parentToolUseID =
        permissionOpts.parentToolUseID?.trim() ??
        sandboxNetworkParentToolUseID(input);
      const activeTokens = tokens;
      if (!parentToolUseID && activeTokens.length > 1) {
        const reason =
          'SDK requested sandbox network access without a parent Bash tool-use id while multiple Bash approvals are active.';
        writeEvent({
          decision: 'sdk_network_gate_denied',
          reason,
          networkToolUseID: permissionOpts.toolUseID,
          hostHash,
          expiredTokenCount,
        });
        return {
          behavior: 'deny',
          message: `${reason} Approve the scoped Bash(...) command through MyClaw first.`,
          interrupt: false,
        };
      }
      const token = parentToolUseID
        ? activeTokens.find(
            (candidate) => candidate.bashToolUseID === parentToolUseID,
          )
        : activeTokens.length > 0
          ? latestToken(activeTokens)
          : undefined;
      if (token) {
        writeEvent({
          decision: 'sdk_network_gate_suppressed',
          reason:
            'SDK requested network approval for a recently approved Bash invocation; suppressing duplicate user approval.',
          networkToolUseID: permissionOpts.toolUseID,
          bashToolUseID: token.bashToolUseID,
          hostHash,
          commandHash: token.commandHash,
          tokenCreatedAtMs: token.createdAtMs,
          tokenExpiresAtMs: token.expiresAtMs,
          expiredTokenCount,
        });
        return { behavior: 'allow', updatedInput: input };
      }

      const reason = parentToolUseID
        ? 'SDK requested sandbox network access for a Bash tool-use id MyClaw did not approve.'
        : 'SDK requested sandbox network access before any Bash tool call was allowed by MyClaw.';
      writeEvent({
        decision: 'sdk_network_gate_denied',
        reason,
        networkToolUseID: permissionOpts.toolUseID,
        ...(parentToolUseID ? { bashToolUseID: parentToolUseID } : {}),
        hostHash,
        expiredTokenCount,
      });
      return {
        behavior: 'deny',
        message: `${reason} Approve the scoped Bash(...) command through MyClaw first.`,
        interrupt: false,
      };
    },
  };
}

function readBashCommand(input: Record<string, unknown>): string | undefined {
  if (typeof input.command === 'string') return input.command;
  if (typeof input.cmd === 'string') return input.cmd;
  return undefined;
}

function sandboxNetworkHostHash(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const host = (input as Record<string, unknown>).host;
  if (typeof host !== 'string' || !host.trim()) return undefined;
  return hashString(host.trim());
}

function sandboxNetworkParentToolUseID(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const value =
    record.parentToolUseID ??
    record.parent_tool_use_id ??
    record.bashToolUseID ??
    record.bash_tool_use_id;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function latestToken(
  tokens: readonly SdkSandboxNetworkApprovalToken[],
): SdkSandboxNetworkApprovalToken | undefined {
  return tokens.reduce<SdkSandboxNetworkApprovalToken | undefined>(
    (latest, token) =>
      !latest || token.createdAtMs >= latest.createdAtMs ? token : latest,
    undefined,
  );
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
