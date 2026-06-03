import { createHash } from 'node:crypto';

import {
  SDK_SANDBOX_NETWORK_ACCESS_TOOL_NAME,
  isSdkSandboxNetworkAccessToolName,
} from '../../../../shared/agent-tool-references.js';
import { evaluateAutonomousToolUse } from '../../../../shared/tool-rule-matcher.js';
import { log } from './logging.js';
import { writeOutput } from './output.js';
import { sandboxBlockedRuntimeEvents } from './sandbox-events.js';
import type { AgentRunnerInput } from './types.js';
import type { CommandBoundNetworkBinding } from '../../../../shared/capability-runtime-access.js';
import { declaredNetworkAuthority } from '../../../../shared/network-host-declaration.js';

export interface SdkSandboxNetworkGate {
  rememberGlobalApproval(principal: string, expiresAtMs: number): void;
  rememberAllowedTool(
    toolName: string,
    input: Record<string, unknown>,
    permissionOpts: { toolUseID?: string },
    principal?: string,
  ): void;
  decide(
    toolName: string,
    input: Record<string, unknown>,
    permissionOpts: { toolUseID?: string; parentToolUseID?: string },
    principal?: string,
  ):
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string; interrupt: false }
    | null;
}

interface SdkSandboxNetworkGlobalApproval {
  createdAtMs: number;
  expiresAtMs: number;
}

interface SdkSandboxNetworkApprovalToken {
  principal: string;
  parentToolUseID: string;
  approvedToolName: string;
  inputHash: string;
  allowParentlessAssociation: boolean;
  restrictedHostHashes?: ReadonlySet<string>;
  createdAtMs: number;
  expiresAtMs: number;
  parentlessAssociatedAtMs?: number;
}

export interface SdkSandboxNetworkGateOptions {
  ttlMs?: number;
  parentlessAssociationTtlMs?: number;
  nowMs?: () => number;
}

const DEFAULT_SANDBOX_NETWORK_TOKEN_TTL_MS = 300_000;
const DEFAULT_PARENTLESS_SANDBOX_NETWORK_ASSOCIATION_TTL_MS = 30_000;
const LOCAL_ONLY_SDK_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'LS',
  'Glob',
  'Grep',
  'TodoWrite',
]);

export function createSdkSandboxNetworkGate(
  agentInput: AgentRunnerInput,
  options: SdkSandboxNetworkGateOptions = {},
): SdkSandboxNetworkGate {
  const ttlMs = options.ttlMs ?? DEFAULT_SANDBOX_NETWORK_TOKEN_TTL_MS;
  const parentlessAssociationTtlMs =
    options.parentlessAssociationTtlMs ??
    DEFAULT_PARENTLESS_SANDBOX_NETWORK_ASSOCIATION_TTL_MS;
  const nowMs = options.nowMs ?? Date.now;
  const tokens: SdkSandboxNetworkApprovalToken[] = [];
  const latestNetworkToolTokenByPrincipal = new Map<
    string,
    SdkSandboxNetworkApprovalToken
  >();
  const globalApprovals = new Map<string, SdkSandboxNetworkGlobalApproval>();

  function writeEvent(input: {
    decision: string;
    reason: string;
    networkToolUseID?: string;
    parentToolUseID?: string;
    approvedToolName?: string;
    hostHash?: string;
    inputHash?: string;
    tokenCreatedAtMs?: number;
    tokenExpiresAtMs?: number;
    tokenTtlMs?: number;
    expiredTokenCount?: number;
  }): void {
    const payload: Record<string, unknown> = {
      toolName: SDK_SANDBOX_NETWORK_ACCESS_TOOL_NAME,
      canonicalCapability: SDK_SANDBOX_NETWORK_ACCESS_TOOL_NAME,
      decision: input.decision,
      reason: input.reason,
      tokenTtlMs: input.tokenTtlMs ?? ttlMs,
      ...(input.networkToolUseID
        ? { networkToolUseIDHash: hashString(input.networkToolUseID) }
        : {}),
      ...(input.parentToolUseID
        ? { parentToolUseIDHash: hashString(input.parentToolUseID) }
        : {}),
      ...(input.approvedToolName
        ? { approvedToolName: input.approvedToolName }
        : {}),
      ...(input.hostHash ? { hostHash: input.hostHash } : {}),
      ...(input.inputHash ? { inputHash: input.inputHash } : {}),
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
        const latest = latestNetworkToolTokenByPrincipal.get(token.principal);
        if (latest === token) {
          latestNetworkToolTokenByPrincipal.delete(token.principal);
        }
      }
    }
    return expired;
  }

  return {
    rememberGlobalApproval(principal, expiresAtMs) {
      const now = nowMs();
      const normalizedPrincipal = principal.trim();
      if (!normalizedPrincipal || expiresAtMs <= now) return;
      globalApprovals.set(normalizedPrincipal, {
        createdAtMs: now,
        expiresAtMs,
      });
      writeEvent({
        decision: 'sdk_network_gate_global_approval_activated',
        reason:
          'Gantry activated a short-lived eligible-tools/SDK-API-prompt approval; SDK sandbox network prompts will be suppressed until it expires.',
        tokenCreatedAtMs: now,
        tokenExpiresAtMs: expiresAtMs,
        tokenTtlMs: expiresAtMs - now,
      });
    },
    rememberAllowedTool(
      toolName,
      input,
      permissionOpts,
      principal = agentInput.agentId ?? 'runner',
    ) {
      if (isSdkSandboxNetworkAccessToolName(toolName)) return;
      if (LOCAL_ONLY_SDK_TOOLS.has(toolName)) return;
      const normalizedPrincipal = principal.trim();
      const parentToolUseID = permissionOpts.toolUseID?.trim();
      if (!normalizedPrincipal || !parentToolUseID) {
        writeEvent({
          decision: 'sdk_network_gate_token_rejected',
          reason:
            'Gantry did not mint a sandbox network token because principal or tool-use id was missing.',
        });
        return;
      }
      const createdAtMs = nowMs();
      const inputHash = hashString(stableJson(input));
      const networkReview = reviewedNetworkHostHashesForToolUse(
        toolName,
        input,
        agentInput,
      );
      const token: SdkSandboxNetworkApprovalToken = {
        principal: normalizedPrincipal,
        parentToolUseID,
        approvedToolName: toolName,
        inputHash,
        allowParentlessAssociation:
          toolName === 'Bash' &&
          networkReview.parentlessEligible &&
          Boolean(networkReview.restrictedHostHashes?.size),
        ...(networkReview.restrictedHostHashes
          ? { restrictedHostHashes: networkReview.restrictedHostHashes }
          : {}),
        createdAtMs,
        expiresAtMs: createdAtMs + ttlMs,
      };
      tokens.push(token);
      if (toolName === 'Bash') {
        latestNetworkToolTokenByPrincipal.set(normalizedPrincipal, token);
      } else {
        latestNetworkToolTokenByPrincipal.delete(normalizedPrincipal);
      }
      writeEvent({
        decision: 'sdk_network_gate_token_minted',
        reason:
          'Gantry minted a short-lived sandbox network token for an approved tool invocation.',
        parentToolUseID,
        approvedToolName: toolName,
        inputHash,
        tokenCreatedAtMs: token.createdAtMs,
        tokenExpiresAtMs: token.expiresAtMs,
      });
    },
    decide(
      toolName,
      input,
      permissionOpts,
      principal = agentInput.agentId ?? 'runner',
    ) {
      if (!isSdkSandboxNetworkAccessToolName(toolName)) return null;

      const hostHash = sandboxNetworkHostHash(input);
      const now = nowMs();
      const expiredTokenCount = pruneExpiredTokens(now);
      const globalApproval = globalApprovals.get(principal);
      if (globalApproval) {
        if (globalApproval.expiresAtMs > now) {
          writeEvent({
            decision: 'sdk_network_gate_global_approval_suppressed',
            reason:
              'SDK requested network approval during an active eligible-tools/SDK-API-prompt approval; suppressing duplicate user approval.',
            networkToolUseID: permissionOpts.toolUseID,
            hostHash,
            tokenCreatedAtMs: globalApproval.createdAtMs,
            tokenExpiresAtMs: globalApproval.expiresAtMs,
            tokenTtlMs: globalApproval.expiresAtMs - globalApproval.createdAtMs,
            expiredTokenCount,
          });
          return { behavior: 'allow', updatedInput: input };
        }
        globalApprovals.delete(principal);
      }
      const parentToolUseID =
        permissionOpts.parentToolUseID?.trim() ??
        sandboxNetworkParentToolUseID(input);
      const activeTokens = tokens.filter(
        (candidate) => candidate.principal === principal,
      );
      const token = parentToolUseID
        ? activeTokens.find(
            (candidate) => candidate.parentToolUseID === parentToolUseID,
          )
        : undefined;
      if (token) {
        if (
          token.restrictedHostHashes &&
          (!hostHash || !token.restrictedHostHashes.has(hostHash))
        ) {
          const reason =
            'SDK requested sandbox network access for a host outside the reviewed tool metadata.';
          writeEvent({
            decision: 'sdk_network_gate_denied',
            reason,
            networkToolUseID: permissionOpts.toolUseID,
            parentToolUseID: token.parentToolUseID,
            approvedToolName: token.approvedToolName,
            hostHash,
            inputHash: token.inputHash,
            expiredTokenCount,
          });
          return {
            behavior: 'deny',
            message: `${reason} Approve the tool call through Gantry first.`,
            interrupt: false,
          };
        }
        writeEvent({
          decision: 'sdk_network_gate_suppressed',
          reason:
            'SDK requested network approval for a recently approved tool invocation; suppressing duplicate user approval.',
          networkToolUseID: permissionOpts.toolUseID,
          parentToolUseID: token.parentToolUseID,
          approvedToolName: token.approvedToolName,
          hostHash,
          inputHash: token.inputHash,
          tokenCreatedAtMs: token.createdAtMs,
          tokenExpiresAtMs: token.expiresAtMs,
          expiredTokenCount,
        });
        return { behavior: 'allow', updatedInput: input };
      }
      if (!parentToolUseID && agentInput.isScheduledJob) {
        const latestToken = latestNetworkToolTokenByPrincipal.get(principal);
        const networkToolUseID = permissionOpts.toolUseID?.trim();
        if (
          latestToken &&
          !latestToken.parentlessAssociatedAtMs &&
          latestToken.approvedToolName === 'Bash' &&
          latestToken.allowParentlessAssociation &&
          networkToolUseID &&
          hostHash &&
          latestToken.restrictedHostHashes?.has(hostHash) &&
          latestToken.expiresAtMs > now &&
          now - latestToken.createdAtMs <= parentlessAssociationTtlMs
        ) {
          latestToken.parentlessAssociatedAtMs = now;
          latestNetworkToolTokenByPrincipal.delete(principal);
          writeEvent({
            decision: 'sdk_network_gate_suppressed_parentless_recent_tool',
            reason:
              'SDK requested network approval without a parent tool-use id immediately after a recently approved scheduled command for the same host; associating it with the latest run-local tool approval.',
            networkToolUseID,
            parentToolUseID: latestToken.parentToolUseID,
            approvedToolName: latestToken.approvedToolName,
            hostHash,
            inputHash: latestToken.inputHash,
            tokenCreatedAtMs: latestToken.createdAtMs,
            tokenExpiresAtMs: latestToken.expiresAtMs,
            expiredTokenCount,
          });
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const reason = parentToolUseID
        ? 'SDK requested sandbox network access for a tool-use id Gantry did not approve.'
        : 'SDK requested sandbox network access without a parent tool-use id.';
      writeEvent({
        decision: 'sdk_network_gate_denied',
        reason,
        networkToolUseID: permissionOpts.toolUseID,
        ...(parentToolUseID ? { parentToolUseID } : {}),
        hostHash,
        expiredTokenCount,
      });
      return {
        behavior: 'deny',
        message: `${reason} Approve the tool call through Gantry first.`,
        interrupt: false,
      };
    },
  };
}

function sandboxNetworkHostHash(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const host = (input as Record<string, unknown>).host;
  if (typeof host !== 'string' || !host.trim()) return undefined;
  const normalized = normalizeNetworkAuthority(host);
  return normalized ? hashString(normalized) : undefined;
}

function sandboxNetworkParentToolUseID(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const value =
    record.parentToolUseID ??
    record.parent_tool_use_id ??
    record.toolUseID ??
    record.tool_use_id;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function reviewedNetworkHostHashesForToolUse(
  toolName: string,
  input: unknown,
  agentInput: AgentRunnerInput,
): { restrictedHostHashes?: Set<string>; parentlessEligible: boolean } {
  if (toolName === 'Bash') {
    const commandBound = commandBoundNetworkHostHashes(input, agentInput);
    return {
      ...(commandBound.hostHashes.size > 0
        ? { restrictedHostHashes: commandBound.hostHashes }
        : {}),
      parentlessEligible: commandBound.matched,
    };
  }
  const mcpHostHashes = mcpServerNetworkHostHashes(toolName, agentInput);
  if (mcpHostHashes) {
    return {
      ...(mcpHostHashes.size > 0
        ? { restrictedHostHashes: mcpHostHashes }
        : {}),
      parentlessEligible: false,
    };
  }
  return { parentlessEligible: false };
}

function commandBoundNetworkHostHashes(
  input: unknown,
  agentInput: AgentRunnerInput,
): { matched: boolean; hostHashes: Set<string> } {
  const hostHashes = new Set<string>();
  let matched = false;
  for (const binding of readCommandBoundNetworkBindings(agentInput)) {
    const commandRules = normalizeStringList(binding.commandRules);
    if (commandRules.length === 0) continue;
    const evaluation = evaluateAutonomousToolUse({
      rules: commandRules,
      toolName: 'Bash',
      toolInput: input,
    });
    if (!evaluation.allowed) continue;
    matched = true;
    for (const host of normalizeStringList(binding.hosts)) {
      const normalized = normalizeNetworkAuthority(host);
      if (normalized) hostHashes.add(hashString(normalized));
    }
  }
  return { matched, hostHashes };
}

function mcpServerNetworkHostHashes(
  toolName: string,
  agentInput: AgentRunnerInput,
): Set<string> | null {
  if (!Array.isArray(agentInput.runtimeAccess)) return null;
  for (const entry of agentInput.runtimeAccess) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      entry.sourceType !== 'mcp_server' ||
      !Array.isArray(entry.allowedTools) ||
      !entry.allowedTools.some((allowedTool) =>
        mcpRuntimeToolRuleMatches(allowedTool, toolName),
      )
    ) {
      continue;
    }
    const hostHashes = new Set<string>();
    for (const host of normalizeStringList(entry.networkHosts)) {
      const normalized = normalizeNetworkAuthority(host);
      if (normalized) hostHashes.add(hashString(normalized));
    }
    return hostHashes;
  }
  return null;
}

function mcpRuntimeToolRuleMatches(rule: unknown, toolName: string): boolean {
  if (typeof rule !== 'string') return false;
  const trimmed = rule.trim();
  if (trimmed === toolName) return true;
  if (trimmed.endsWith('*')) {
    return toolName.startsWith(trimmed.slice(0, -1));
  }
  return false;
}

function readCommandBoundNetworkBindings(
  agentInput: AgentRunnerInput,
): CommandBoundNetworkBinding[] {
  if (!Array.isArray(agentInput.runtimeAccess)) return [];
  return agentInput.runtimeAccess.flatMap(
    (entry): CommandBoundNetworkBinding[] => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        (entry.sourceType !== 'local_cli' &&
          entry.sourceType !== 'skill_action') ||
        !Array.isArray(entry.networkBindings)
      ) {
        return [];
      }
      return entry.networkBindings.filter(
        (binding): binding is CommandBoundNetworkBinding =>
          Boolean(binding && typeof binding === 'object') &&
          Array.isArray(binding.commandRules) &&
          Array.isArray(binding.hosts),
      );
    },
  );
}

function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) out.add(trimmed);
  }
  return [...out];
}

function normalizeNetworkAuthority(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const declared = declaredNetworkAuthority(trimmed);
  if (declared) return declared;
  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(
        /\.+$/,
        '',
      )}:${parsed.port || defaultPortForProtocol(parsed.protocol)}`;
  } catch {
    return undefined;
  }
}

function defaultPortForProtocol(protocol: string): string {
  return protocol === 'http:' ? '80' : '443';
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = stableValue(record[key]);
    }
    return out;
  }
  return value;
}
