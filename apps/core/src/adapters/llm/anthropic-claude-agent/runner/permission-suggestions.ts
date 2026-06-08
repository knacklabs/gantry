import {
  isKnownProjectedBrowserMcpToolName,
  isSdkSandboxNetworkAccessToolName,
  parseReadableScopedToolRule,
  publicGantryToolNameForSdkTool,
  RUN_COMMAND_TOOL_NAME,
} from '../../../../shared/agent-tool-references.js';
import {
  normalizeBashLeafRuleContent,
  nonDurableBashLeafReason,
  parseBashCommand,
} from '../../../../shared/bash-command-parser.js';
import { permissionUpdateAllowedToolRules } from '../../../../shared/permission-tool-rules.js';
import { validatePersistentRequestPermissionRule } from '../../../../shared/persistent-permission-rules.js';
import {
  expandSemanticCapabilityPermissionRules,
  semanticCapabilityRuntimeRules,
  type SemanticCapabilityDefinition,
  validateSemanticCapabilityDefinition,
} from '../../../../shared/semantic-capabilities.js';
import {
  canonicalizeGeneratedRuntimeSkillPaths,
  containsGeneratedRuntimeSkillPath,
} from '../../../../shared/generated-runtime-paths.js';
import { NEUTRAL_CA_TRUST_ENV_KEYS } from '../../../../shared/neutral-ca-trust-env.js';
import { semanticCapabilityRule } from '../../../../shared/semantic-capability-ids.js';
import { evaluateAutonomousToolUse } from '../../../../shared/tool-rule-matcher.js';

export interface PermissionSuggestionPlan {
  suggestions?: unknown[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}

const GANTRY_SKILL_ACTIONS_ENV = 'GANTRY_SKILL_ACTIONS_JSON';

export function synthesizePermissionSuggestions(
  toolName: string,
  options: {
    blockedPath?: string;
    toolInput?: unknown;
    semanticCapabilityDefinitions?: readonly SemanticCapabilityDefinition[];
  },
): unknown[] | undefined {
  return synthesizePermissionSuggestionPlan(toolName, options).suggestions;
}

export function synthesizePermissionSuggestionPlan(
  toolName: string,
  options: {
    blockedPath?: string;
    toolInput?: unknown;
    semanticCapabilityDefinitions?: readonly SemanticCapabilityDefinition[];
  },
): PermissionSuggestionPlan {
  const normalizedToolName = permissionRequestToolName(toolName.trim());
  if (!normalizedToolName) return {};
  if (isSdkSandboxNetworkAccessToolName(normalizedToolName)) return {};
  if (normalizedToolName === 'Browser') {
    return { suggestions: exactToolPermissionSuggestion('Browser') };
  }
  const skillAction = skillActionPermissionSuggestion(
    normalizedToolName,
    options,
  );
  if (skillAction) return skillAction;
  if (normalizedToolName === RUN_COMMAND_TOOL_NAME) {
    const commands = inferBashRuleContents(options.toolInput);
    if (!commands.length) return {};
    const rules = commands.map(
      (command) => `${RUN_COMMAND_TOOL_NAME}(${command})`,
    );
    if (rules.some((rule) => !validatePersistentRule(rule))) {
      return {};
    }
    return {
      suggestions: scopedToolPermissionSuggestion(
        RUN_COMMAND_TOOL_NAME,
        commands.map((command) => ({ ruleContent: command })),
      ),
    };
  }
  if (!validatePersistentRule(normalizedToolName)) return {};
  return { suggestions: exactToolPermissionSuggestion(normalizedToolName) };
}

export function scheduledPermissionSuggestions(
  toolName: string,
  sdkSuggestions: readonly unknown[] | undefined,
  options: {
    blockedPath?: string;
    toolInput?: unknown;
    semanticCapabilityDefinitions?: readonly SemanticCapabilityDefinition[];
  },
): unknown[] | undefined {
  return scheduledPermissionSuggestionPlan(toolName, sdkSuggestions, options)
    .suggestions;
}

export function livePermissionRulesForUpdates(
  updates: readonly unknown[] | undefined,
  plan: PermissionSuggestionPlan,
): string[] {
  return expandSemanticCapabilityPermissionRules({
    rules: permissionUpdateAllowedToolRules(updates),
    definitions: plan.semanticCapabilityDefinitions,
  });
}

export function scheduledPermissionSuggestionPlan(
  toolName: string,
  sdkSuggestions: readonly unknown[] | undefined,
  options: {
    blockedPath?: string;
    toolInput?: unknown;
    semanticCapabilityDefinitions?: readonly SemanticCapabilityDefinition[];
  },
): PermissionSuggestionPlan {
  const normalizedToolName = toolName.trim();
  if (!normalizedToolName) return {};
  const publicToolName = permissionRequestToolName(normalizedToolName);
  if (isSdkSandboxNetworkAccessToolName(publicToolName)) return {};
  if (publicToolName === 'Browser') {
    return { suggestions: browserPermissionSuggestion() };
  }
  const skillAction = skillActionPermissionSuggestion(publicToolName, options);
  if (skillAction) return skillAction;
  const normalizedSdkSuggestions =
    normalizePermissionSuggestions(sdkSuggestions);
  if (normalizedSdkSuggestions) {
    return { suggestions: normalizedSdkSuggestions };
  }
  return synthesizePermissionSuggestionPlan(publicToolName, options);
}

export function readRunnerSkillActionCapabilities(): SemanticCapabilityDefinition[] {
  const raw = process.env[GANTRY_SKILL_ACTIONS_ENV];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const capabilities: SemanticCapabilityDefinition[] = [];
    for (const entry of parsed.slice(0, 100)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      const capability = entry as SemanticCapabilityDefinition;
      if (!capability.capabilityId?.startsWith('skill.')) continue;
      if (capability.credentialSource === 'local_cli') continue;
      const validation = validateSemanticCapabilityDefinition(capability);
      if (validation.ok) capabilities.push(capability);
    }
    return capabilities;
  } catch {
    return [];
  }
}

function normalizePermissionSuggestions(
  sdkSuggestions: readonly unknown[] | undefined,
): unknown[] | undefined {
  const rawAllowedRules = permissionUpdateAllowedToolRules(sdkSuggestions);
  if (rawAllowedRules.some(containsGeneratedRuntimeSkillPath)) {
    return undefined;
  }
  const allowedRules = rawAllowedRules.map(
    canonicalizeGeneratedRuntimeSkillPaths,
  );
  if (allowedRules.length === 0) return undefined;
  if (allowedRules.some((rule) => !validatePersistentRule(rule))) {
    return undefined;
  }
  if (allowedRules.length === 1) {
    const [rule] = allowedRules;
    if (!rule) return undefined;
    const [toolName, ruleContent] = splitReadableToolRule(rule);
    if (toolName === 'Browser') return browserPermissionSuggestion();
    if (ruleContent)
      return scopedToolPermissionSuggestion(toolName, ruleContent);
    return exactToolPermissionSuggestion(toolName);
  }
  return [
    {
      type: 'addRules',
      behavior: 'allow',
      destination: 'session',
      rules: allowedRules.map((rule) => {
        const [toolName, ruleContent] = splitReadableToolRule(rule);
        return {
          toolName,
          ...(ruleContent ? { ruleContent } : {}),
        };
      }),
    },
  ];
}

export function browserPermissionSuggestion(): unknown[] {
  return exactToolPermissionSuggestion('Browser');
}

function exactToolPermissionSuggestion(toolName: string): unknown[] {
  return [
    {
      type: 'addRules',
      behavior: 'allow',
      destination: 'session',
      rules: [
        {
          toolName,
        },
      ],
    },
  ];
}

function scopedToolPermissionSuggestion(
  toolName: string,
  rules: string | Array<{ ruleContent: string }>,
): unknown[] {
  const normalizedRules =
    typeof rules === 'string'
      ? [{ toolName, ruleContent: rules }]
      : rules.map((rule) => ({ toolName, ruleContent: rule.ruleContent }));
  return [
    {
      type: 'addRules',
      behavior: 'allow',
      destination: 'session',
      rules: normalizedRules,
    },
  ];
}

export function permissionRequestToolName(toolName: string): string {
  return isKnownProjectedBrowserMcpToolName(toolName.trim())
    ? 'Browser'
    : publicGantryToolNameForSdkTool(toolName);
}

function inferBashRuleContents(toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const input = toolInput as Record<string, unknown>;
  const command = input.command ?? input.cmd;
  if (typeof command !== 'string') return [];
  const rawCommand = command.trim();
  if (containsGeneratedRuntimeSkillPath(rawCommand)) return [];
  const trimmed = canonicalizeGeneratedRuntimeSkillPaths(rawCommand);
  if (!trimmed || trimmed.length > 2048) return [];
  const parsed = parseBashCommand(trimmed);
  if (!parsed.ok) return [];
  if (
    parsed.leaves.some((leaf) =>
      leaf.redirects.some((redirect) => redirect.destructive),
    )
  ) {
    return [];
  }
  if (parsed.leaves.some((leaf) => nonDurableBashLeafReason(leaf))) {
    return [];
  }
  const rules = parsed.leaves
    .map(normalizeBashLeafRuleContent)
    .filter((rule): rule is string => Boolean(rule));
  return [...new Set(rules)];
}

function skillActionPermissionSuggestion(
  publicToolName: string,
  options: {
    toolInput?: unknown;
    semanticCapabilityDefinitions?: readonly SemanticCapabilityDefinition[];
  },
): PermissionSuggestionPlan | undefined {
  if (publicToolName !== RUN_COMMAND_TOOL_NAME) return undefined;
  const matches = skillActionDefinitionsForToolInput(
    options.toolInput,
    options.semanticCapabilityDefinitions,
  ).filter((definition) =>
    skillActionDefinitionMatchesToolInput(definition, options.toolInput),
  );
  if (matches.length !== 1) return undefined;
  const capability = matches[0];
  const rule = semanticCapabilityRule(capability.capabilityId);
  if (
    !validatePersistentRequestPermissionRule(rule, {
      semanticCapabilityDefinitions: {
        [capability.capabilityId]: capability,
      },
    }).ok
  ) {
    return undefined;
  }
  return {
    suggestions: exactToolPermissionSuggestion(rule),
    semanticCapabilityDefinitions: {
      [capability.capabilityId]: capability,
    },
  };
}

function skillActionDefinitionsForToolInput(
  _toolInput: unknown,
  definitions: readonly SemanticCapabilityDefinition[] | undefined,
): SemanticCapabilityDefinition[] {
  const seen = new Set<string>();
  const out: SemanticCapabilityDefinition[] = [];
  for (const definition of definitions ?? []) {
    if (!definition.capabilityId?.startsWith('skill.')) continue;
    if (definition.credentialSource === 'local_cli') continue;
    if (seen.has(definition.capabilityId)) continue;
    if (!validateSemanticCapabilityDefinition(definition).ok) continue;
    seen.add(definition.capabilityId);
    out.push(definition);
  }
  return out;
}

function skillActionDefinitionMatchesToolInput(
  definition: SemanticCapabilityDefinition,
  toolInput: unknown,
): boolean {
  const rules = semanticCapabilityRuntimeRules(definition).filter((rule) => {
    const scoped = parseReadableScopedToolRule(rule);
    return scoped?.toolName === RUN_COMMAND_TOOL_NAME;
  });
  if (rules.length === 0) return false;
  const normalizedToolInput =
    canonicalizeToolInputGeneratedRuntimePaths(toolInput);
  return evaluateAutonomousToolUse({
    rules,
    toolName: 'Bash',
    toolInput: normalizedToolInput,
  }).allowed;
}

function canonicalizeToolInputGeneratedRuntimePaths(
  toolInput: unknown,
): unknown {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return toolInput;
  }
  const input = toolInput as Record<string, unknown>;
  const next = { ...input };
  if (typeof next.command === 'string') {
    next.command = canonicalizeSkillActionCommandForMatching(next.command);
  }
  if (typeof next.cmd === 'string') {
    next.cmd = canonicalizeSkillActionCommandForMatching(next.cmd);
  }
  return next;
}

function canonicalizeSkillActionCommandForMatching(command: string): string {
  return stripRuntimeManagedEnvAssignments(
    canonicalizeProjectSkillRoot(
      canonicalizeGeneratedRuntimeSkillPaths(command),
    ),
  );
}

function canonicalizeProjectSkillRoot(command: string): string {
  return command
    .replace(
      /(["']?)\$\{CLAUDE_PROJECT_DIR\}\/skills\//g,
      (_match, quote: string) => `${quote}skills/`,
    )
    .replace(
      /(["']?)\$CLAUDE_PROJECT_DIR\/skills\//g,
      (_match, quote: string) => `${quote}skills/`,
    );
}

function stripRuntimeManagedEnvAssignments(command: string): string {
  let remaining = command.trimStart();
  let changed = false;
  do {
    changed = false;
    for (const key of NEUTRAL_CA_TRUST_ENV_KEYS) {
      const pattern = new RegExp(
        `^${escapeRegex(key)}=(?:"?\\$\\{?NODE_EXTRA_CA_CERTS\\}?"?|'\\$\\{?NODE_EXTRA_CA_CERTS\\}?')\\s+`,
      );
      const next = remaining.replace(pattern, '');
      if (next !== remaining) {
        remaining = next.trimStart();
        changed = true;
      }
    }
  } while (changed);
  return remaining;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function splitReadableToolRule(rule: string): [string, string | undefined] {
  const open = rule.indexOf('(');
  if (open <= 0 || !rule.endsWith(')')) return [rule, undefined];
  return [rule.slice(0, open), rule.slice(open + 1, -1)];
}

function validatePersistentRule(rule: string): boolean {
  return validatePersistentRequestPermissionRule(rule).ok;
}
