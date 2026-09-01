import {
  bashExecutableName,
  formatBashArgv,
  type BashCommandLeaf,
  isPythonScriptPath,
  nonDurableBashLeafReason,
  normalizeBashLeafRuleContent,
  parseBashCommand,
  wildcardSensitiveBashLeafReason,
} from './bash-command-parser.js';
import { isRemoteContentExecutionBashCommand } from './remote-content-execution.js';
import { normalizeRuntimeOwnedBashCommandForMatching } from './tool-rule-runtime-command.js';

const MAX_SYNTHESIZED_COMMAND_LENGTH = 2_048;

export function synthesizeFamilyRunCommandRuleContents(
  command: string,
): string[] {
  const normalized = normalizeRuntimeOwnedBashCommandForMatching(command);
  if (!normalized || normalized.length > MAX_SYNTHESIZED_COMMAND_LENGTH) {
    return [];
  }
  if (isRemoteContentExecutionBashCommand(normalized)) return [];
  const parsed = parseBashCommand(normalized);
  if (!parsed.ok || parsed.piped) return [];

  const contents: string[] = [];
  for (const leaf of parsed.leaves) {
    const content = synthesizeFamilyRunCommandRuleContentForLeaf(leaf);
    if (!content) return [];
    contents.push(content);
  }
  return [...new Set(contents)];
}

export function synthesizeFamilyRunCommandRuleContentForLeaf(
  leaf: BashCommandLeaf,
): string | undefined {
  if (leaf.redirects.some((redirect) => redirect.destructive)) return undefined;
  if (nonDurableBashLeafReason(leaf)) return undefined;
  if (runnerShimBashLeafReason(leaf)) return undefined;
  if (isRemoteContentExecutionBashCommand(leaf.commandText)) return undefined;

  const reviewedScriptRule = reviewedSkillScriptRule(leaf);
  if (reviewedScriptRule) return reviewedScriptRule;

  const executable = leaf.argv[0];
  if (!executable || !isLiteralFamilyExecutable(executable)) return undefined;
  const familyRule = `${formatBashArgv([executable])} *`;
  if (wildcardSensitiveBashLeafReason(leaf, familyRule)) return undefined;
  return familyRule;
}

export function isFamilyRunCommandRule(rule: string): boolean {
  const trimmed = rule.trim();
  const prefix = 'RunCommand(';
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith(')')) return false;
  return isFamilyRunCommandRuleContent(trimmed.slice(prefix.length, -1).trim());
}

export function isFamilyRunCommandRuleContent(scope: string): boolean {
  const parsed = parseBashCommand(scope.trim());
  if (!parsed.ok || parsed.piped || parsed.leaves.length !== 1) return false;
  const leaf = parsed.leaves[0];
  if (!leaf || leaf.redirects.length > 0) return false;
  if (leaf.argv.length !== 2 || leaf.argv[1] !== '*') return false;
  if (reviewedSkillScriptRule(leaf)) return false;
  return isLiteralFamilyExecutable(leaf.argv[0] ?? '');
}

export function matchedFamilyRule(
  match: { matchedRule?: string; matchedRules?: string[] },
  capabilityByRule: ReadonlyMap<string, string>,
): true | undefined {
  const rules =
    match.matchedRules ?? (match.matchedRule ? [match.matchedRule] : []);
  return (
    rules.some(
      (rule) => !capabilityByRule.has(rule) && isFamilyRunCommandRule(rule),
    ) || undefined
  );
}

function reviewedSkillScriptRule(leaf: BashCommandLeaf): string | undefined {
  const executable = leaf.argv[0]?.split('/').filter(Boolean).at(-1);
  const script =
    executable === 'python' || executable === 'python3'
      ? leaf.argv[1]
      : leaf.argv[0];
  if (!script?.endsWith('.py')) return undefined;
  if (!script.replace(/^\.\/+/, '').startsWith('skills/')) return undefined;
  return normalizeBashLeafRuleContent(leaf);
}

// Runner shims execute arbitrary registry packages, so a family grant that
// covers one would be an unbounded execution grant: `npx *` runs anything on
// npm, and a legitimate `npm *` family must not silently cover `npm exec`.
// They never mint families here, and the decision coordinator consults
// runnerShimFamilyBypassReason on the exact command so a stored family cannot
// be honored for a shim invocation either.
const RUNNER_SHIM_EXECUTABLES = new Set(['npx', 'pnpx', 'uvx']);
const RUNNER_SHIM_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  bun: new Set(['x']),
  npm: new Set(['exec', 'x']),
  pnpm: new Set(['dlx', 'exec']),
  yarn: new Set(['dlx', 'exec']),
};

export function runnerShimBashLeafReason(
  leaf: BashCommandLeaf,
): string | undefined {
  const executable = bashExecutableName(leaf.argv[0] ?? '');
  if (RUNNER_SHIM_EXECUTABLES.has(executable)) {
    return `${executable} runs arbitrary packages; command-family grants cannot cover it.`;
  }
  const subcommand = leaf.argv[1];
  if (subcommand && RUNNER_SHIM_SUBCOMMANDS[executable]?.has(subcommand)) {
    return `${executable} ${subcommand} runs arbitrary packages; command-family grants cannot cover it.`;
  }
  return undefined;
}

export function runnerShimFamilyBypassReason(
  command: string,
): string | undefined {
  const normalized =
    normalizeRuntimeOwnedBashCommandForMatching(command) || command;
  const parsed = parseBashCommand(normalized);
  if (!parsed.ok) return undefined;
  for (const leaf of parsed.leaves) {
    const reason = runnerShimBashLeafReason(leaf);
    if (reason) return reason;
  }
  return undefined;
}

function isLiteralFamilyExecutable(executable: string): boolean {
  if (!executable || /[*?[\]]/.test(executable)) return false;
  // Script-leaf argv0 forms (the canonical script normalizer's domain) are
  // NEVER families: `RunCommand(/workspace/report.py *)` would grant broad
  // durable authority to a script whose later arguments were never reviewed.
  // Reviewed skills/ scripts take the reviewedSkillScriptRule path instead.
  if (isPythonScriptPath(executable)) return false;
  // Absolute paths must be POSITIVELY literal (autoreview round 4): a token
  // like `/$TOOL` or `/${TOOL}` resolves per-environment to a different
  // binary, so persisting it as a family would let one grant cover arbitrary
  // executables and blind the rails, which inspect the unresolved command.
  if (executable.startsWith('/')) {
    return /^\/[A-Za-z0-9._+:/-]+$/.test(executable);
  }
  // Relative paths are excluded BY CONTRACT (task plan: bare word or absolute
  // path): a relative argv0 resolves per-cwd, so `tools/acme *` could match a
  // different binary in another working directory. Exact-argv rules remain
  // available for relative executables.
  if (executable.includes('/')) return false;
  return /^[A-Za-z0-9_][A-Za-z0-9._+:-]*$/.test(executable);
}
