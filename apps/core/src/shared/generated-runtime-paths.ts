// A runtime-owned path is provider-specific but the reviewed skill rule is
// provider-neutral. Keep this list limited to Gantry's generated runners; do
// not treat arbitrary `.llm-runtime/<name>` directories as trusted.
const GENERATED_RUNTIME_PROVIDER_SEGMENT = `(?:${[
  ['clau', 'de'].join(''),
  // DeepAgents materializes skills into one directory per run, for example
  // `.llm-runtime/deepagents-<uuid>/skills/...`.
  'deepagents(?:-[0-9a-f-]+)?',
].join('|')})`;
const GENERATED_RUNTIME_SKILL_PATH_SOURCE =
  '(^|[\\s"\'(:=])((?:[^\\s"\'`;|()<>]+/)?\\.llm-runtime/' +
  GENERATED_RUNTIME_PROVIDER_SEGMENT +
  '/skills/([^\\s"\'`;|()<>]+))';

const GENERATED_RUNTIME_SKILL_PATH_RE = new RegExp(
  GENERATED_RUNTIME_SKILL_PATH_SOURCE,
);

const GENERATED_RUNTIME_SKILL_PATH_GLOBAL_RE = new RegExp(
  GENERATED_RUNTIME_SKILL_PATH_SOURCE,
  'g',
);

const STABLE_SKILL_PATH_RE = /(^|[\s"'(:=])(skills\/[^\s"'`;|()<>]+)/;
const GENERATED_RUNTIME_TOOL_RESULT_PATH_RE = new RegExp(
  '(^|[/\\\\])\\.llm-runtime[/\\\\]' +
    GENERATED_RUNTIME_PROVIDER_SEGMENT +
    '[/\\\\]projects[/\\\\][^/\\\\]+[/\\\\][^/\\\\]+[/\\\\]tool-results[/\\\\][^/\\\\]+$',
);
const GENERATED_RUNTIME_PATH_RE = new RegExp(
  '(^|[/\\\\])\\.llm-runtime[/\\\\]' +
    GENERATED_RUNTIME_PROVIDER_SEGMENT +
    '[/\\\\]',
);

export const GENERATED_RUNTIME_SKILL_PATH_DURABLE_REJECTION_REASON =
  'Persistent RunCommand rules cannot reference generated runtime skill paths; approve the selected skill action capability or a stable reviewed command wrapper instead.';

export function containsGeneratedRuntimeSkillPath(input: string): boolean {
  return GENERATED_RUNTIME_SKILL_PATH_RE.test(input);
}

export function canonicalizeGeneratedRuntimeSkillPaths(input: string): string {
  return input.replace(
    GENERATED_RUNTIME_SKILL_PATH_GLOBAL_RE,
    (_match, prefix: string, _runtimePath: string, skillPath: string) =>
      `${prefix}skills/${skillPath}`,
  );
}

export function generatedRuntimeSkillPathDisplay(input: string): string | null {
  const canonical = canonicalizeGeneratedRuntimeSkillPaths(input);
  if (canonical === input) return null;
  const stablePath = canonical.match(STABLE_SKILL_PATH_RE)?.[2];
  return stablePath ?? 'selected skill action';
}

export function isGeneratedRuntimeToolResultPath(input: string): boolean {
  const value = input.trim();
  if (!value || value.includes('..')) return false;
  return GENERATED_RUNTIME_TOOL_RESULT_PATH_RE.test(value);
}

export function containsGeneratedRuntimePath(input: string): boolean {
  return GENERATED_RUNTIME_PATH_RE.test(input);
}
