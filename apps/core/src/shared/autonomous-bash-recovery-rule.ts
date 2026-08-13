import {
  bashExecutableName,
  nonDurableBashLeafReason,
  normalizeBashLeafRuleContent,
  parseBashCommand,
} from './bash-command-parser.js';
import { containsGeneratedRuntimePath } from './generated-runtime-paths.js';
import { normalizeRuntimeOwnedBashCommandForMatching } from './tool-rule-matcher.js';

export function persistentAutonomousBashRecoveryRule(
  command: string,
): string | undefined {
  const normalized = normalizeRuntimeOwnedBashCommandForMatching(command);
  if (containsGeneratedRuntimePath(normalized)) return undefined;
  const parsed = parseBashCommand(normalized);
  if (!parsed.ok || parsed.leaves.length !== 1) return undefined;
  const [leaf] = parsed.leaves;
  if (!leaf || nonDurableBashLeafReason(leaf)) return undefined;
  if (inlineInterpreterLeaf(leaf.argv)) return undefined;
  if (leaf.redirects.some((redirect) => redirect.destructive)) return undefined;
  return normalizeBashLeafRuleContent(leaf);
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
