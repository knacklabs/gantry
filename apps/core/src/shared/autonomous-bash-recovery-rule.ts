import type { BashCommandLeaf } from './bash-command-parser.js';
import {
  bashExecutableName,
  nonDurableBashLeafReason,
  parseBashCommand,
} from './bash-command-parser.js';
import {
  synthesizeFamilyRunCommandRuleContentForLeaf,
  synthesizeFamilyRunCommandRuleContents,
} from './family-rule-synthesis.js';
import { containsGeneratedRuntimePath } from './generated-runtime-paths.js';
import { normalizeRuntimeOwnedBashCommandForMatching } from './tool-rule-matcher.js';

// A single command leaf can back a durable autonomous RunCommand family rule
// only when it is not a stateful shell builtin, not an inline interpreter
// (`node -e`, `python -c`, ...), and carries no destructive redirect.
export function persistentAutonomousBashRecoveryRuleForLeaf(
  leaf: BashCommandLeaf,
): string | undefined {
  return synthesizeFamilyRunCommandRuleContentForLeaf(leaf);
}

export function persistentAutonomousBashRecoveryRule(
  command: string,
): string | undefined {
  const normalized = normalizeRuntimeOwnedBashCommandForMatching(command);
  if (containsGeneratedRuntimePath(normalized)) return undefined;
  const parsed = parseBashCommand(normalized);
  if (!parsed.ok || parsed.leaves.length !== 1) return undefined;
  return synthesizeFamilyRunCommandRuleContents(normalized)[0];
}

export type AutonomousCompoundBashRecovery =
  // Every part can be granted individually: the per-leaf family rule
  // contents (raw; the caller JSON-encodes them into request_access actions the
  // same way the single-command recovery does).
  | { kind: 'grantable'; rules: string[] }
  // The compound cannot be granted. `reason` is a fixed, non-command-derived
  // explanation; `part` (when present) is the safe 1-based index of the specific
  // offending leaf, absent when the whole command is at fault (e.g. a pipe).
  | { kind: 'blocked'; part?: number; reason: string };

// A COMPOUND command (leaves joined by &&/||/;/pipe) can never be a single
// durable rule. For a control-flow-only compound (&&/||/;, no data flow) this
// tells the autonomous recovery to grant each part's access and re-run the
// ORIGINAL command instead of dead-ending; a piped compound is blocked outright
// (see below). Returns undefined for a single-leaf command (the caller already
// has a scoped-rule path for that) or a command that cannot be parsed safely.
export function autonomousCompoundBashRecovery(
  command: string,
): AutonomousCompoundBashRecovery | undefined {
  const normalized = normalizeRuntimeOwnedBashCommandForMatching(command);
  if (containsGeneratedRuntimePath(normalized)) return undefined;
  const parsed = parseBashCommand(normalized);
  if (!parsed.ok || parsed.leaves.length <= 1) return undefined;
  // A pipe feeds one leaf's output into the next as DATA, and that data can be
  // program text for whatever the downstream leaf runs (`data | julia`,
  // `... | python`). Per-leaf durable rules cannot be proven safe without
  // resolving each sink's stdin semantics, and enumerating every interpreter is
  // unsound. So only offer per-leaf grants for control-flow-only compounds
  // (`&&`/`||`/`;`, no data flow); block anything containing a pipe.
  if (parsed.piped) {
    return {
      kind: 'blocked',
      reason:
        'it pipes data between commands, and a piped command may execute that data as its program.',
    };
  }
  const rules: string[] = [];
  for (let index = 0; index < parsed.leaves.length; index += 1) {
    const leaf = parsed.leaves[index]!;
    const reason = nondurableLeafReason(leaf);
    const content = synthesizeFamilyRunCommandRuleContentForLeaf(leaf);
    if (reason || !content) {
      return {
        kind: 'blocked',
        part: index + 1,
        reason: reason ?? 'a part cannot be expressed as a scoped rule.',
      };
    }
    // Push the canonical family rule: it is serialized with proper JSON
    // escaping by the caller, so the original leaf and later argument variants
    // share the same durable authority boundary.
    rules.push(content);
  }
  return { kind: 'grantable', rules: [...new Set(rules)] };
}

export function autonomousBashAuthorityAddition(command: string) {
  const rule = persistentAutonomousBashRecoveryRule(command);
  if (rule) {
    return {
      type: 'addRules' as const,
      behavior: 'allow' as const,
      rules: [{ toolName: 'RunCommand', ruleContent: rule }],
    };
  }
  const compound = autonomousCompoundBashRecovery(command);
  return compound?.kind === 'grantable'
    ? {
        type: 'addRules' as const,
        behavior: 'allow' as const,
        rules: compound.rules.map((ruleContent) => ({
          toolName: 'RunCommand',
          ruleContent,
        })),
      }
    : undefined;
}

// Full autonomous-run recovery guidance for a denied Bash command: a single
// scoped RunCommand rule when the command is one durable leaf, an actionable
// per-part grant for a control-flow-only compound, or a fixed "blocked"/dead-end
// message. `escapeJson` is injected so the caller keeps one JSON-escaping impl.
export function autonomousBashRecoveryMessage(
  command: string | undefined,
  escapeJson: (value: string) => string,
): string {
  const rule = command
    ? persistentAutonomousBashRecoveryRule(command)
    : undefined;
  if (rule) {
    return `request_access { "target": { "kind": "run_command", "argvPattern": "${escapeJson(rule)}" }, "temporaryOnly": false, "reason": "This autonomous run needs scoped command access." }`;
  }
  // A COMPOUND command (&&/||/;/pipe) can never be one durable rule, but its
  // parts usually can be — give an ACTIONABLE recovery instead of a dead end.
  const compound = command
    ? autonomousCompoundBashRecovery(command)
    : undefined;
  if (compound?.kind === 'grantable') {
    const requests = compound.rules
      .map(
        (r) =>
          `request_access { "target": { "kind": "run_command", "argvPattern": "${escapeJson(r)}" }, "temporaryOnly": false, "reason": "This autonomous run needs scoped command access." }`,
      )
      .join(' ');
    return `This is a compound command (${compound.rules.length} commands joined by &&/||/;); autonomous runs authorize one command at a time, so it cannot be granted as a single rule. Grant each part's access: ${requests} Then re-run the ORIGINAL command unchanged once every part is granted. Do not split it into separate runs — the &&/||/; control flow must be preserved.`;
  }
  if (compound?.kind === 'blocked') {
    const detail =
      compound.part !== undefined
        ? `part ${compound.part} cannot be durably granted: ${compound.reason}`
        : `it cannot be durably granted because ${compound.reason}`;
    return `This is a compound command and cannot be fully approved for autonomous runs — ${detail} Reformulate the whole operation to use a reviewed semantic capability, or to individually-grantable commands that keep the same control flow — do not run only part of it.`;
  }
  return 'Update the autonomous run to use a reviewed semantic capability or invoke a scoped RunCommand(...) command directly. This command cannot be durably approved for autonomous runs.';
}

function nondurableLeafReason(leaf: BashCommandLeaf): string | undefined {
  const stateful = nonDurableBashLeafReason(leaf);
  if (stateful) return stateful;
  if (inlineInterpreterLeaf(leaf.argv)) {
    return 'An inline interpreter command (node -e / python -c / ...) cannot be persisted as a scoped rule.';
  }
  if (leaf.redirects.some((redirect) => redirect.destructive)) {
    return 'A destructive redirect cannot be persisted as a scoped rule.';
  }
  return undefined;
}

function inlineInterpreterLeaf(argv: readonly string[]): boolean {
  const executable = bashExecutableName(argv[0] ?? '');
  if (
    !['node', 'python', 'python3', 'ruby', 'perl', 'php'].includes(executable)
  ) {
    return false;
  }
  return ['-c', '-e'].includes(argv[1] ?? '');
}
