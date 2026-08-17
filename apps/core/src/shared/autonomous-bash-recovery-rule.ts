import type { BashCommandLeaf } from './bash-command-parser.js';
import {
  bashExecutableName,
  nonDurableBashLeafReason,
  normalizeBashLeafRuleContent,
  parseBashCommand,
} from './bash-command-parser.js';
import { containsGeneratedRuntimePath } from './generated-runtime-paths.js';
import { normalizeRuntimeOwnedBashCommandForMatching } from './tool-rule-matcher.js';

// A single reviewed-command leaf can back a durable autonomous RunCommand rule
// only when it is not a stateful shell builtin, not an inline interpreter
// (`node -e`, `python -c`, ...), and carries no destructive redirect.
export function persistentAutonomousBashRecoveryRuleForLeaf(
  leaf: BashCommandLeaf,
): string | undefined {
  if (nondurableLeafReason(leaf)) return undefined;
  return normalizeBashLeafRuleContent(leaf);
}

export function persistentAutonomousBashRecoveryRule(
  command: string,
): string | undefined {
  const normalized = normalizeRuntimeOwnedBashCommandForMatching(command);
  if (containsGeneratedRuntimePath(normalized)) return undefined;
  const parsed = parseBashCommand(normalized);
  if (!parsed.ok || parsed.leaves.length !== 1) return undefined;
  const [leaf] = parsed.leaves;
  return leaf ? persistentAutonomousBashRecoveryRuleForLeaf(leaf) : undefined;
}

export type AutonomousCompoundBashRecovery =
  // Every part can be granted individually: the per-leaf reviewed-command rule
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
    const content = normalizeBashLeafRuleContent(leaf);
    if (reason || !content) {
      return {
        kind: 'blocked',
        part: index + 1,
        reason: reason ?? 'a part cannot be expressed as a scoped rule.',
      };
    }
    // Push the EXACT reviewed-command rule (no mutation): it is serialized with
    // proper JSON escaping by the caller, so it authorizes the same leaf when
    // the agent re-runs the original compound command.
    rules.push(content);
  }
  return { kind: 'grantable', rules: [...new Set(rules)] };
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
