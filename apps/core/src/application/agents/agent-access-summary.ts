import type { AgentToolAccessView } from '../../shared/tool-access-view.js';
import { humanizeTechnicalIdentifier } from '../../shared/user-visible-messages.js';
import { skillActionCapabilityDisplayName } from '../../shared/semantic-capabilities.js';

export interface AgentAccessSummaryEntry {
  label: string;
  detail: string;
}

export interface AgentAccessSummary {
  /** Active sources used in every conversation. detail = scope label. */
  connected: AgentAccessSummaryEntry[];
  /** Granted access. detail = 'future access' | 'current setup'. */
  allowed: AgentAccessSummaryEntry[];
  /** Plain blockers. label = blocker, detail = one next action. */
  needsAttention: AgentAccessSummaryEntry[];
  /** Conservative removable access. label = access label, detail = reason. */
  suggestedCleanup: AgentAccessSummaryEntry[];
}

export interface AgentAccessSummaryInput {
  sources: {
    skills?: { id: string; name?: string }[];
    mcpServers?: { id: string; tools?: string[] }[];
    tools?: { id: string; kind?: string }[];
  };
  selections: { id: string; version: string }[];
  toolAccess: AgentToolAccessView;
  pendingRequests?: {
    targetLabel: string;
    status: 'pending' | 'expired';
    expiresAt?: string;
  }[];
  disabledToolBindings?: { id: string }[];
}

const ALLOWED_FUTURE = 'future access';
const ALLOWED_CURRENT = 'current setup';

/**
 * Plain user-facing label for an access value. Bare ids are resolved through
 * the same canonical display-name helpers used by permission prompts/receipts
 * (`skillActionCapabilityDisplayName`, then `humanizeTechnicalIdentifier`), so
 * the summary never diverges from those surfaces or leaks raw ids. Values that
 * already contain whitespace are display strings produced upstream (e.g.
 * `toolAccess.configuredTools` formatted by `formatToolRuleForUser` —
 * "Generated skill action (…)", "matching command access (…)") and are
 * returned verbatim to avoid re-formatting/mangling them.
 */
function displayLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (/\s/.test(trimmed)) return trimmed;
  return (
    skillActionCapabilityDisplayName(trimmed) ??
    humanizeTechnicalIdentifier(trimmed)
  );
}

export function buildAgentAccessSummary(
  input: AgentAccessSummaryInput,
): AgentAccessSummary {
  const connected: AgentAccessSummaryEntry[] = [];
  for (const skill of input.sources.skills ?? []) {
    connected.push({
      label: skill.name || displayLabel(skill.id),
      detail: 'skill',
    });
  }
  for (const server of input.sources.mcpServers ?? []) {
    const tools = (server.tools ?? [])
      .map((tool) => tool.trim())
      .filter(Boolean);
    connected.push({
      label: displayLabel(server.id),
      detail: tools.length > 0 ? tools.join(', ') : 'all reviewed tools',
    });
  }
  for (const tool of input.sources.tools ?? []) {
    connected.push({
      label: displayLabel(tool.id),
      detail: tool.kind || 'tool',
    });
  }

  const allowed: AgentAccessSummaryEntry[] = [];
  const allowedSeen = new Set<string>();
  const pushAllowed = (label: string, detail: string) => {
    const key = `${label}::${detail}`;
    if (allowedSeen.has(key)) return;
    allowedSeen.add(key);
    allowed.push({ label, detail });
  };
  for (const selection of input.selections) {
    pushAllowed(displayLabel(selection.id), ALLOWED_FUTURE);
  }
  for (const tool of input.toolAccess.configuredTools) {
    pushAllowed(displayLabel(tool), ALLOWED_CURRENT);
  }

  const needsAttention: AgentAccessSummaryEntry[] = [];
  const suggestedCleanup: AgentAccessSummaryEntry[] = [];
  for (const binding of input.disabledToolBindings ?? []) {
    suggestedCleanup.push({
      label: displayLabel(binding.id),
      detail: 'No longer used. You can remove it.',
    });
  }
  // Each pending request lands in exactly one bucket: a still-pending request
  // is an actionable blocker; an expired one is safe to clear. Unknown statuses
  // are ignored rather than defaulted into either bucket.
  for (const request of input.pendingRequests ?? []) {
    if (request.status === 'pending') {
      needsAttention.push({
        label: `${request.targetLabel} is awaiting approval`,
        detail: "Approve it in the agent's chat.",
      });
    } else if (request.status === 'expired') {
      suggestedCleanup.push({
        label: request.targetLabel,
        detail: 'Expired request. Safe to clear.',
      });
    }
  }

  return { connected, allowed, needsAttention, suggestedCleanup };
}

/**
 * Build the read-only summary from raw service inputs. Disabled tool bindings
 * become conservative cleanup suggestions.
 *
 * `pendingRequests` is intentionally not sourced here: `Needs attention` must
 * only show concrete per-agent blockers, and the repository port exposes only
 * app-wide `countPendingAccessRequests`, never a per-agent listing. Populating
 * per-agent pending/expired rows is a deferred follow-up that requires a new
 * `listPendingForAgent({ appId, agentId })` contract on the repository port and
 * adapter. Until then callers pass `pendingRequests` empty — never the app-wide
 * count. See docs/architecture/capability-management.md "Deferred surface impact".
 */
export function summarizeAgentAccess(input: {
  sources: AgentAccessSummaryInput['sources'];
  capabilities: { id: string; version: string }[];
  toolAccess: AgentToolAccessView;
  toolBindings: { toolId: unknown; status?: string }[];
}): AgentAccessSummary {
  return buildAgentAccessSummary({
    sources: input.sources,
    selections: input.capabilities,
    toolAccess: input.toolAccess,
    disabledToolBindings: input.toolBindings
      .filter((binding) => binding.status === 'disabled')
      .map((binding) => ({ id: String(binding.toolId) })),
  });
}
