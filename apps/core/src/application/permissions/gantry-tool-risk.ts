import type { PermissionRiskLevel } from '../../domain/types.js';
import {
  ADMIN_MCP_TOOL_NAMES,
  ALL_GANTRY_MCP_TOOL_NAMES,
  classifyDurableGantryMcpToolName,
} from '../../shared/admin-mcp-tools.js';

const GANTRY_MCP_PREFIX = 'mcp__gantry__';

const ALL_GANTRY_TOOL_NAME_SET = new Set<string>(ALL_GANTRY_MCP_TOOL_NAMES);
const ADMIN_GANTRY_TOOL_NAME_SET = new Set<string>(ADMIN_MCP_TOOL_NAMES);

// A read-only shape: the tool lists/inspects/polls state and never mutates.
// Verbs are matched as whole underscore-delimited tokens so `render_status`
// (display) and `scheduler_get_job` (read) qualify, while a mutating verb is
// never accidentally captured.
const READ_VERB =
  /(?:^|_)(?:list|get|read|search|query|describe|status|inspect|preview|summary|pending|wait)(?:_|$)/;

// An irreversible or blast-radius verb. Any gantry tool whose name carries one
// stays ask-worthy even inside an otherwise-boundable family (e.g.
// `scheduler_delete_job`).
const DESTRUCTIVE_VERB =
  /(?:^|_)(?:delete|remove|revoke|purge|destroy|wipe|reset|restart|drop)(?:_|$)/;

// Pure display / user-interaction surfaces. Side-effect-free for the operator,
// who sees the real payload. NB: send_message is deliberately NOT here — it is
// an external mutation (see EXTERNAL_MUTATION_TOOLS).
const DISPLAY_INTERACTION_TOOLS = new Set<string>([
  'ask_user_question',
  'todo_update',
]);

// External mutations whose risk depends on destination + payload (can disclose
// private data, reach unintended recipients, or trigger downstream automation),
// so they must not auto-approve from the tool name alone. Normal
// current-conversation messaging is birthright-granted by the deterministic
// rails BEFORE the classifier tail (permission-deterministic-rails.ts:
// GANTRY_INPUT_GATED_BIRTHRIGHT_TOOLS), so this HIGH default only applies to
// send_message requests birthright did NOT cover (e.g. risk-sanitized input),
// which should ask. ponytail: arg-aware classification (auto-approve the current
// conversation / known recipient, HIGH for arbitrary destinations) is the richer
// fix if we ever surface send_message shapes birthright doesn't already cover.
const EXTERNAL_MUTATION_TOOLS = new Set<string>(['send_message']);

// Tools whose blast radius depends on arguments this deterministic map does not
// inspect, and where the worst case is dangerous. `file` can perform protected
// config writes, so the whole tool asks rather than auto-approving a list/read.
const ARG_DEPENDENT_HIGH_RISK_TOOLS = new Set<string>(['file']);

export interface GantryToolRisk {
  risk_level: PermissionRiskLevel;
  reason: string;
}

/**
 * Resolve the canonical gantry tool name from either the namespaced
 * `mcp__gantry__<name>` form or a bare canonical name. Returns null when the
 * tool is not gantry-native (a third-party MCP tool, Bash, etc.).
 */
export function gantryNativeCanonicalToolName(
  toolName: string,
): { canonical: string; known: boolean } | null {
  const trimmed = toolName.trim();
  if (trimmed.startsWith(GANTRY_MCP_PREFIX)) {
    const canonical = trimmed.slice(GANTRY_MCP_PREFIX.length);
    return { canonical, known: ALL_GANTRY_TOOL_NAME_SET.has(canonical) };
  }
  return ALL_GANTRY_TOOL_NAME_SET.has(trimmed)
    ? { canonical: trimmed, known: true }
    : null;
}

/**
 * Default, config-free risk rating for a gantry-native tool.
 *
 * Returns undefined for non-gantry tools (they keep the existing Bash /
 * third-party-MCP / LLM classifier path). For gantry tools the rating is
 * derived from the tool's effect, reusing the canonical durability buckets so
 * the map stays in sync as tools are added:
 *   - unboundable / authority / decision-actor buckets, destructive verbs,
 *     admin mutations, and arg-dependent-dangerous tools -> high (ask).
 *   - read/inspect shapes and pure display -> low (auto-approve).
 *   - boundable routine mutations -> medium (auto-approve).
 *   - external mutations (send_message) and mutating browser actions -> high
 *     (ask; effect depends on destination/payload / unbounded real-world effect).
 *   - anything unmapped or unknown -> high (never silently auto-approve an
 *     unknown gantry mutation).
 */
export function gantryToolDefaultRisk(
  toolName: string,
): GantryToolRisk | undefined {
  const gantry = gantryNativeCanonicalToolName(toolName);
  if (!gantry) return undefined;
  const { canonical, known } = gantry;

  if (!known) {
    return high(`Unmapped gantry tool ${canonical}; ask the user.`);
  }

  const bucket = classifyDurableGantryMcpToolName(canonical);
  if (
    bucket === 'authority-changing' ||
    bucket === 'unscoped-dispatcher' ||
    bucket === 'delegation' ||
    bucket === 'decision-actor'
  ) {
    return high(
      `Gantry ${canonical} changes authority or dispatches unbounded effects; ask the user.`,
    );
  }
  if (DESTRUCTIVE_VERB.test(canonical)) {
    return high(
      `Gantry ${canonical} is destructive or irreversible; ask the user.`,
    );
  }
  if (ARG_DEPENDENT_HIGH_RISK_TOOLS.has(canonical)) {
    return high(
      `Gantry ${canonical} can mutate protected state depending on arguments; ask the user.`,
    );
  }
  if (EXTERNAL_MUTATION_TOOLS.has(canonical)) {
    return high(
      `Gantry ${canonical} sends an external message whose effect depends on destination and payload; ask the user.`,
    );
  }
  if (ADMIN_GANTRY_TOOL_NAME_SET.has(canonical) && !READ_VERB.test(canonical)) {
    return high(
      `Gantry admin tool ${canonical} mutates configuration; ask the user.`,
    );
  }

  if (READ_VERB.test(canonical) || DISPLAY_INTERACTION_TOOLS.has(canonical)) {
    return low(`Gantry ${canonical} is a read-only or display action.`);
  }
  // A "bounded browser session" does NOT bound real-world effect: browser_act
  // can submit forms, publish data, confirm purchases, or trigger destructive
  // account actions. Any mutating browser tool asks. Read-only browser ops
  // (browser_status / browser_inspect) already returned low via READ_VERB.
  // ponytail: arg-level classification of non-mutating actions can auto-approve
  // later; HIGH default now.
  if (canonical.startsWith('browser_')) {
    return high(
      `Gantry ${canonical} performs a browser action with unbounded real-world effect; ask the user.`,
    );
  }
  if (bucket === 'grantable-exact') {
    return medium(`Gantry ${canonical} is a routine, boundable mutation.`);
  }

  // Known gantry tool that matched no rule above (e.g. a gated runtime
  // projection that is not a browser action) -> ask rather than guess.
  return high(`Gantry ${canonical} has no low-risk default; ask the user.`);
}

function low(reason: string): GantryToolRisk {
  return { risk_level: 'low', reason };
}

function medium(reason: string): GantryToolRisk {
  return { risk_level: 'medium', reason };
}

function high(reason: string): GantryToolRisk {
  return { risk_level: 'high', reason };
}
