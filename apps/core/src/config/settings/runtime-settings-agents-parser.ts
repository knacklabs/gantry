import path from 'node:path';

import { BUILTIN_COMMAND_NAMES } from '../../application/commands/builtin-command-names.js';
import { parseAgentPersona } from '../../shared/agent-persona.js';
import { parsePromptSurface } from '../../shared/prompt-surface.js';
import type { ThinkingOverride } from '../../domain/types.js';
import {
  resolveModelSelection,
  resolveModelSelectionForWorkload,
} from '../../shared/model-catalog.js';
import type {
  RuntimeConfiguredAgent,
  RuntimeConfiguredAgentBinding,
  RuntimeConfiguredAgentCapability,
  RuntimeConfiguredAgentGuardrail,
  RuntimeConfiguredAgentMemory,
  RuntimeConfiguredAgentPlugins,
  RuntimeConfiguredAgentSourceRef,
  RuntimeConfiguredAgentSources,
  RuntimeConfiguredAgentToolSurface,
  RuntimeDesiredStateSettings,
} from './runtime-settings-types.js';
import { isRestrictableGantryMcpToolName } from '../../shared/gantry-mcp-tool-catalog.js';
import { isAdminMcpToolName } from '../../shared/admin-mcp-tools.js';
import { isAvailableNativeSdkTool } from '../../shared/native-sdk-tool-names.js';

function parseStringValue(
  raw: unknown,
  pathPrefix: string,
  fallback?: string,
): string {
  if (raw === undefined && fallback !== undefined) return fallback;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`${pathPrefix} must be a non-empty string`);
  }
  return raw.trim();
}

function parseBooleanValue(
  raw: unknown,
  pathPrefix: string,
  fallback?: boolean,
): boolean {
  if (raw === undefined && fallback !== undefined) return fallback;
  if (typeof raw !== 'boolean') {
    throw new Error(`${pathPrefix} must be true/false`);
  }
  return raw;
}

function parseOptionalBooleanValue(
  raw: unknown,
  pathPrefix: string,
  fallback: boolean,
): boolean {
  if (raw === undefined) return fallback;
  return parseBooleanValue(raw, pathPrefix);
}

function isValidSettingsAgentFolder(folder: string): boolean {
  if (!folder || folder !== folder.trim()) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  return folder.toLowerCase() !== 'global' && folder.toLowerCase() !== 'shared';
}

function parseVersionValue(raw: unknown, pathPrefix: string): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return parseStringValue(raw, pathPrefix);
}

function parseConfiguredAgentSourceRef(
  raw: unknown,
  pathPrefix: string,
  options: {
    allowVersion?: boolean;
    requireVersion?: boolean;
    requireKind?: boolean;
  },
): RuntimeConfiguredAgentSourceRef {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }
  const map = raw as Record<string, unknown>;
  const allowVersion = options.allowVersion ?? true;
  for (const key of Object.keys(map)) {
    if (key !== 'name' && key !== 'id' && key !== 'version' && key !== 'kind') {
      throw new Error(
        `${pathPrefix}.${key} is not supported. Configure name, id, version, or kind.`,
      );
    }
    if (key === 'version' && !allowVersion) {
      throw new Error(
        `${pathPrefix}.version is not supported. Configure id only.`,
      );
    }
  }
  const source: RuntimeConfiguredAgentSourceRef = {
    id: parseStringValue(map.id, `${pathPrefix}.id`),
  };
  if (map.name !== undefined) {
    source.name = parseStringValue(map.name, `${pathPrefix}.name`);
  }
  if (map.version !== undefined || options.requireVersion) {
    source.version = parseVersionValue(map.version, `${pathPrefix}.version`);
  }
  if (map.kind !== undefined || options.requireKind) {
    const kind = parseStringValue(map.kind, `${pathPrefix}.kind`);
    if (
      kind !== 'builtin' &&
      kind !== 'skill' &&
      kind !== 'mcp' &&
      kind !== 'adapter' &&
      kind !== 'local_cli'
    ) {
      throw new Error(
        `${pathPrefix}.kind must be builtin, skill, mcp, adapter, or local_cli`,
      );
    }
    source.kind = kind;
  }
  return source;
}

function parseConfiguredAgentSourceArray(
  raw: unknown,
  pathPrefix: string,
  options: {
    allowVersion?: boolean;
    requireVersion?: boolean;
    requireKind?: boolean;
  },
): RuntimeConfiguredAgentSourceRef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${pathPrefix} must be an array`);
  return raw.map((item, index) =>
    parseConfiguredAgentSourceRef(item, `${pathPrefix}[${index}]`, options),
  );
}

function parseConfiguredAgentSources(
  raw: unknown,
  pathPrefix: string,
): RuntimeConfiguredAgentSources {
  if (raw === undefined) return { skills: [], mcpServers: [], tools: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (key !== 'skills' && key !== 'mcp_servers' && key !== 'tools') {
      throw new Error(
        `${pathPrefix}.${key} is not supported. Configure skills, mcp_servers, or tools.`,
      );
    }
  }
  return {
    skills: parseConfiguredAgentSourceArray(
      map.skills,
      `${pathPrefix}.skills`,
      { allowVersion: false },
    ),
    mcpServers: parseConfiguredAgentSourceArray(
      map.mcp_servers,
      `${pathPrefix}.mcp_servers`,
      { allowVersion: false },
    ),
    tools: parseConfiguredAgentSourceArray(map.tools, `${pathPrefix}.tools`, {
      requireKind: true,
    }),
  };
}

function parseConfiguredAgentGuardrail(
  raw: unknown,
  pathPrefix: string,
): RuntimeConfiguredAgentGuardrail | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (
      key !== 'file' &&
      key !== 'model' &&
      key !== 'mode' &&
      key !== 'unresolved'
    ) {
      throw new Error(
        `${pathPrefix}.${key} is not supported. Configure file, model, mode, or unresolved.`,
      );
    }
  }
  const file = parsePluginRelativePath(map.file, `${pathPrefix}.file`);
  const model = parseStringValue(map.model, `${pathPrefix}.model`);
  const resolved = resolveModelSelection(model);
  if (!resolved.ok) {
    throw new Error(`${pathPrefix}.model is invalid: ${resolved.message}`);
  }
  const mode =
    map.mode === undefined
      ? 'both'
      : parseGuardrailMode(map.mode, `${pathPrefix}.mode`);
  const unresolved = validateGuardrailUnresolved(
    map.unresolved,
    mode,
    pathPrefix,
  );
  return { file, model, mode, unresolved };
}

function parseGuardrailMode(
  raw: unknown,
  pathPrefix: string,
): NonNullable<RuntimeConfiguredAgentGuardrail['mode']> {
  const value = parseStringValue(raw, pathPrefix);
  if (value === 'both' || value === 'deterministic' || value === 'classifier') {
    return value;
  }
  throw new Error(
    `${pathPrefix} must be one of both, deterministic, or classifier`,
  );
}

// Validate `unresolved` against `mode` and fail fast on contradictory combos.
// - mode: classifier  → no `unresolved` (the classifier runs every turn).
// - mode: both        → `unresolved` absent or `classifier`; defaults classifier.
// - mode: deterministic → `unresolved` required ∈ {clarify, allow, reject, inline}.
function validateGuardrailUnresolved(
  raw: unknown,
  mode: NonNullable<RuntimeConfiguredAgentGuardrail['mode']>,
  pathPrefix: string,
): RuntimeConfiguredAgentGuardrail['unresolved'] {
  const present = raw !== undefined;
  const value = present
    ? parseStringValue(raw, `${pathPrefix}.unresolved`)
    : undefined;
  const ALL = ['clarify', 'allow', 'reject', 'inline', 'classifier'] as const;
  if (value !== undefined && !(ALL as readonly string[]).includes(value)) {
    throw new Error(
      `${pathPrefix}.unresolved must be one of ${ALL.join(', ')}`,
    );
  }
  if (mode === 'classifier') {
    if (present) {
      throw new Error(
        `${pathPrefix}.unresolved is not valid with mode: classifier (the classifier runs every turn)`,
      );
    }
    return undefined;
  }
  if (mode === 'both') {
    if (present && value !== 'classifier') {
      throw new Error(
        `${pathPrefix}: mode: both only supports unresolved: classifier`,
      );
    }
    return 'classifier';
  }
  // mode === 'deterministic'
  if (!present) {
    throw new Error(
      `${pathPrefix}: mode: deterministic requires unresolved: clarify | allow | reject | inline`,
    );
  }
  if (value === 'classifier') {
    throw new Error(`${pathPrefix}: use mode: both for classifier escalation`);
  }
  return value as RuntimeConfiguredAgentGuardrail['unresolved'];
}

// A skill id is a single folder name under `skills/` — keep it a plain segment.
function parsePluginPathSegment(raw: unknown, pathPrefix: string): string {
  const value = parseStringValue(raw, pathPrefix);
  if (
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('..') ||
    path.isAbsolute(value)
  ) {
    throw new Error(
      `${pathPrefix} must be a plain name inside the agent folder (no "/", "\\", or "..")`,
    );
  }
  return value;
}

// A guardrail/extraction reference may live in a sub-folder of the agent dir
// (e.g. "guardrails/guardrail.ts"). Forward-slash sub-paths are allowed, but
// never an absolute path, a backslash, or a segment that climbs out of the
// folder. (The folder itself is already path-escape validated, and the loader
// re-checks containment at read time as defense in depth.)
function parsePluginRelativePath(raw: unknown, pathPrefix: string): string {
  const value = parseStringValue(raw, pathPrefix);
  if (value.includes('\\') || path.isAbsolute(value)) {
    throw new Error(
      `${pathPrefix} must be a relative path inside the agent folder (no backslashes or absolute paths)`,
    );
  }
  if (
    value.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
  ) {
    throw new Error(
      `${pathPrefix} must be a relative path inside the agent folder (no empty, "." or ".." segments)`,
    );
  }
  return value;
}

function parseConfiguredAgentPlugins(
  raw: unknown,
  pathPrefix: string,
): RuntimeConfiguredAgentPlugins | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (
      key !== 'guardrail' &&
      key !== 'memory_extraction' &&
      key !== 'skills' &&
      key !== 'commands' &&
      key !== 'pre_run_context'
    ) {
      throw new Error(
        `${pathPrefix}.${key} is not supported. Configure guardrail, memory_extraction, skills, commands, or pre_run_context.`,
      );
    }
  }
  const plugins: RuntimeConfiguredAgentPlugins = {};
  const guardrail = parseConfiguredAgentGuardrail(
    map.guardrail,
    `${pathPrefix}.guardrail`,
  );
  if (guardrail) plugins.guardrail = guardrail;
  if (map.memory_extraction !== undefined) {
    plugins.memoryExtraction = parsePluginRelativePath(
      map.memory_extraction,
      `${pathPrefix}.memory_extraction`,
    );
  }
  if (map.skills !== undefined) {
    if (!Array.isArray(map.skills)) {
      throw new Error(`${pathPrefix}.skills must be an array of skill ids`);
    }
    plugins.skills = map.skills.map((item, index) =>
      parsePluginPathSegment(item, `${pathPrefix}.skills[${index}]`),
    );
  }
  if (map.commands !== undefined) {
    if (!Array.isArray(map.commands)) {
      throw new Error(
        `${pathPrefix}.commands must be an array of command names`,
      );
    }
    plugins.commands = map.commands.map((item, index) => {
      const name = parseStringValue(item, `${pathPrefix}.commands[${index}]`);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        throw new Error(
          `${pathPrefix}.commands[${index}] must be kebab-case (lowercase, hyphen-separated)`,
        );
      }
      if (BUILTIN_COMMAND_NAMES.has(name)) {
        throw new Error(
          `${pathPrefix}.commands[${index}] "${name}" collides with a built-in command`,
        );
      }
      return name;
    });
  }
  if (map.pre_run_context !== undefined) {
    if (!Array.isArray(map.pre_run_context)) {
      throw new Error(
        `${pathPrefix}.pre_run_context must be an array of provider names`,
      );
    }
    plugins.preRunContext = map.pre_run_context.map((item, index) => {
      const name = parseStringValue(
        item,
        `${pathPrefix}.pre_run_context[${index}]`,
      );
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        throw new Error(
          `${pathPrefix}.pre_run_context[${index}] must be kebab-case (lowercase, hyphen-separated)`,
        );
      }
      return name;
    });
  }
  return plugins;
}

function parseConfiguredAgentMemory(
  raw: unknown,
  pathPrefix: string,
): RuntimeConfiguredAgentMemory | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (key !== 'idle_end_minutes') {
      throw new Error(
        `${pathPrefix}.${key} is not supported. Configure idle_end_minutes.`,
      );
    }
  }
  const memory: RuntimeConfiguredAgentMemory = {};
  if (map.idle_end_minutes !== undefined) {
    const value = map.idle_end_minutes;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 1440
    ) {
      throw new Error(
        `${pathPrefix}.idle_end_minutes must be an integer between 1 and 1440 (minutes).`,
      );
    }
    memory.idleEndMinutes = value;
  }
  return Object.keys(memory).length > 0 ? memory : undefined;
}

function parseConfiguredAgentToolSurface(
  raw: unknown,
  pathPrefix: string,
): RuntimeConfiguredAgentToolSurface | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (key !== 'gantry_mcp' && key !== 'native') {
      throw new Error(
        `${pathPrefix}.${key} is not supported. Configure gantry_mcp (gantry MCP tool keep-list) and/or native (native SDK tool keep-list).`,
      );
    }
  }
  const surface: RuntimeConfiguredAgentToolSurface = {};
  if (map.gantry_mcp !== undefined) {
    if (!Array.isArray(map.gantry_mcp)) {
      throw new Error(
        `${pathPrefix}.gantry_mcp must be a list of gantry MCP tool names`,
      );
    }
    const names = new Set<string>();
    for (const [index, item] of map.gantry_mcp.entries()) {
      const itemPath = `${pathPrefix}.gantry_mcp[${index}]`;
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw new Error(`${itemPath} must be a non-empty string`);
      }
      const name = item.trim();
      if (isAdminMcpToolName(name)) {
        throw new Error(
          `${itemPath} "${name}" is a Gantry admin tool; grant it via capabilities, not tool_surface.`,
        );
      }
      if (!isRestrictableGantryMcpToolName(name)) {
        throw new Error(
          `${itemPath} "${name}" is not a known gantry MCP tool name.`,
        );
      }
      names.add(name);
    }
    surface.gantryMcp = [...names].sort();
  }
  if (map.native !== undefined) {
    if (!Array.isArray(map.native)) {
      throw new Error(
        `${pathPrefix}.native must be a list of native SDK tool names`,
      );
    }
    const names = new Set<string>();
    for (const [index, item] of map.native.entries()) {
      const itemPath = `${pathPrefix}.native[${index}]`;
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw new Error(`${itemPath} must be a non-empty string`);
      }
      const name = item.trim();
      if (!isAvailableNativeSdkTool(name)) {
        throw new Error(
          `${itemPath} "${name}" is not a known native SDK tool name.`,
        );
      }
      names.add(name);
    }
    surface.native = [...names].sort();
  }
  return Object.keys(surface).length > 0 ? surface : undefined;
}

function parseConfiguredAgentThinking(
  raw: unknown,
  pathPrefix: string,
): ThinkingOverride | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (key !== 'mode' && key !== 'effort' && key !== 'budget_tokens') {
      throw new Error(
        `${pathPrefix}.${key} is not supported. Configure mode, effort, or budget_tokens.`,
      );
    }
  }
  const mode = parseStringValue(map.mode, `${pathPrefix}.mode`);
  if (mode !== 'adaptive' && mode !== 'enabled' && mode !== 'disabled') {
    throw new Error(
      `${pathPrefix}.mode must be adaptive, enabled, or disabled`,
    );
  }
  const thinking: ThinkingOverride = { mode };
  if (map.effort !== undefined) {
    const effort = parseStringValue(map.effort, `${pathPrefix}.effort`);
    if (
      effort !== 'low' &&
      effort !== 'medium' &&
      effort !== 'high' &&
      effort !== 'max'
    ) {
      throw new Error(`${pathPrefix}.effort must be low, medium, high, or max`);
    }
    thinking.effort = effort;
  }
  if (map.budget_tokens !== undefined) {
    if (
      typeof map.budget_tokens !== 'number' ||
      !Number.isInteger(map.budget_tokens) ||
      map.budget_tokens <= 0
    ) {
      throw new Error(`${pathPrefix}.budget_tokens must be a positive integer`);
    }
    thinking.budgetTokens = map.budget_tokens;
  }
  return thinking;
}

function parseConfiguredAgentCapabilities(
  raw: unknown,
  pathPrefix: string,
): RuntimeConfiguredAgentCapability[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `${pathPrefix} must be an array of selected capability entries`,
    );
  }
  return raw.map((item, index) => {
    const itemPath = `${pathPrefix}[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`${itemPath} must be a mapping`);
    }
    const map = item as Record<string, unknown>;
    for (const key of Object.keys(map)) {
      if (key !== 'id' && key !== 'version') {
        throw new Error(
          `${itemPath}.${key} is not supported. Configure id and version.`,
        );
      }
    }
    return {
      id: parseStringValue(map.id, `${itemPath}.id`),
      version: parseVersionValue(map.version, `${itemPath}.version`),
    };
  });
}

function parseConfiguredAgentBindings(
  raw: unknown,
  pathPrefix: string,
  fallback: {
    jid?: unknown;
    name?: string;
    trigger?: unknown;
    addedAt?: unknown;
    requiresTrigger?: unknown;
    model?: string;
  },
): Record<string, RuntimeConfiguredAgentBinding> {
  if (raw === undefined) {
    const jid =
      fallback.jid === undefined
        ? ''
        : parseStringValue(fallback.jid, `${pathPrefix}.primary.jid`);
    if (!jid) return {};
    return {
      primary: {
        jid,
        name: fallback.name,
        trigger: parseStringValue(
          fallback.trigger,
          `${pathPrefix}.primary.trigger`,
          '@Default Agent',
        ),
        addedAt: parseStringValue(
          fallback.addedAt,
          `${pathPrefix}.primary.added_at`,
          new Date(0).toISOString(),
        ),
        requiresTrigger: parseOptionalBooleanValue(
          fallback.requiresTrigger,
          `${pathPrefix}.primary.requires_trigger`,
          true,
        ),
        model: fallback.model,
      },
    };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }
  const result: Record<string, RuntimeConfiguredAgentBinding> = {};
  for (const [bindingId, bindingRaw] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const bindingPath = `${pathPrefix}.${bindingId}`;
    if (!/^[A-Za-z0-9_.:@-]{1,96}$/.test(bindingId)) {
      throw new Error(`${bindingPath} must use a stable binding id`);
    }
    if (
      typeof bindingRaw !== 'object' ||
      bindingRaw === null ||
      Array.isArray(bindingRaw)
    ) {
      throw new Error(`${bindingPath} must be a mapping`);
    }
    const map = bindingRaw as Record<string, unknown>;
    for (const key of Object.keys(map)) {
      if (
        key !== 'jid' &&
        key !== 'provider' &&
        key !== 'name' &&
        key !== 'trigger' &&
        key !== 'added_at' &&
        key !== 'requires_trigger' &&
        key !== 'model'
      ) {
        throw new Error(
          `${bindingPath}.${key} is not supported. Configure jid, provider, name, trigger, added_at, requires_trigger, or model.`,
        );
      }
    }
    const model =
      map.model === undefined
        ? undefined
        : typeof map.model === 'string' && map.model.trim() === ''
          ? undefined
          : parseStringValue(map.model, `${bindingPath}.model`);
    if (model) {
      const resolved = resolveModelSelectionForWorkload(model, 'chat');
      if (!resolved.ok) {
        throw new Error(`${bindingPath}.model is invalid: ${resolved.message}`);
      }
    }
    result[bindingId] = {
      jid: parseStringValue(map.jid, `${bindingPath}.jid`),
      provider:
        map.provider === undefined
          ? undefined
          : parseStringValue(map.provider, `${bindingPath}.provider`),
      name:
        map.name === undefined
          ? undefined
          : parseStringValue(map.name, `${bindingPath}.name`),
      trigger: parseStringValue(map.trigger, `${bindingPath}.trigger`),
      addedAt: parseStringValue(map.added_at, `${bindingPath}.added_at`),
      requiresTrigger: parseOptionalBooleanValue(
        map.requires_trigger,
        `${bindingPath}.requires_trigger`,
        true,
      ),
      model,
    };
  }
  return result;
}

export function parseConfiguredAgents(
  raw: unknown,
): Record<string, RuntimeConfiguredAgent> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('agents must be a mapping');
  }
  const result: Record<string, RuntimeConfiguredAgent> = {};
  for (const [folder, agentRaw] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const pathPrefix = `agents.${folder}`;
    if (!isValidSettingsAgentFolder(folder)) {
      throw new Error(`${pathPrefix} must be a valid agent folder id`);
    }
    if (
      typeof agentRaw !== 'object' ||
      agentRaw === null ||
      Array.isArray(agentRaw)
    ) {
      throw new Error(`${pathPrefix} must be a mapping`);
    }
    const map = agentRaw as Record<string, unknown>;
    for (const key of Object.keys(map)) {
      if (
        key !== 'name' &&
        key !== 'persona' &&
        key !== 'prompt_surface' &&
        key !== 'jid' &&
        key !== 'trigger' &&
        key !== 'added_at' &&
        key !== 'requires_trigger' &&
        key !== 'model' &&
        key !== 'one_time_job_default_model' &&
        key !== 'recurring_job_default_model' &&
        key !== 'thinking' &&
        key !== 'plugins' &&
        key !== 'memory' &&
        key !== 'tool_surface' &&
        key !== 'bindings' &&
        key !== 'sources' &&
        key !== 'capabilities'
      ) {
        throw new Error(
          `${pathPrefix}.${key} is not supported. Configure name, persona, prompt_surface, model, job model defaults, thinking, plugins (guardrail/memory_extraction/skills/commands/pre_run_context), memory (idle_end_minutes), tool_surface (gantry_mcp), bindings, sources, or capabilities.`,
        );
      }
    }
    const model =
      map.model === undefined
        ? undefined
        : typeof map.model === 'string' && map.model.trim() === ''
          ? undefined
          : parseStringValue(map.model, `${pathPrefix}.model`);
    if (model) {
      const resolved = resolveModelSelectionForWorkload(model, 'chat');
      if (!resolved.ok) {
        throw new Error(`${pathPrefix}.model is invalid: ${resolved.message}`);
      }
    }
    const oneTimeJobDefaultModel =
      map.one_time_job_default_model === undefined
        ? undefined
        : parseStringValue(
            map.one_time_job_default_model,
            `${pathPrefix}.one_time_job_default_model`,
          );
    if (oneTimeJobDefaultModel) {
      const resolved = resolveModelSelectionForWorkload(
        oneTimeJobDefaultModel,
        'one_time_job',
      );
      if (!resolved.ok) {
        throw new Error(
          `${pathPrefix}.one_time_job_default_model is invalid: ${resolved.message}`,
        );
      }
    }
    const recurringJobDefaultModel =
      map.recurring_job_default_model === undefined
        ? undefined
        : parseStringValue(
            map.recurring_job_default_model,
            `${pathPrefix}.recurring_job_default_model`,
          );
    if (recurringJobDefaultModel) {
      const resolved = resolveModelSelectionForWorkload(
        recurringJobDefaultModel,
        'recurring_job',
      );
      if (!resolved.ok) {
        throw new Error(
          `${pathPrefix}.recurring_job_default_model is invalid: ${resolved.message}`,
        );
      }
    }
    result[folder] = {
      name: parseStringValue(map.name, `${pathPrefix}.name`),
      folder,
      persona: parseAgentPersona(map.persona, `${pathPrefix}.persona`),
      promptSurface: parsePromptSurface(
        map.prompt_surface,
        `${pathPrefix}.prompt_surface`,
      ),
      model,
      oneTimeJobDefaultModel,
      recurringJobDefaultModel,
      thinking: parseConfiguredAgentThinking(
        map.thinking,
        `${pathPrefix}.thinking`,
      ),
      plugins: parseConfiguredAgentPlugins(
        map.plugins,
        `${pathPrefix}.plugins`,
      ),
      memory: parseConfiguredAgentMemory(map.memory, `${pathPrefix}.memory`),
      toolSurface: parseConfiguredAgentToolSurface(
        map.tool_surface,
        `${pathPrefix}.tool_surface`,
      ),
      bindings: parseConfiguredAgentBindings(
        map.bindings,
        `${pathPrefix}.bindings`,
        {
          jid: map.jid,
          name:
            typeof map.name === 'string' && map.name.trim()
              ? map.name.trim()
              : undefined,
          trigger: map.trigger,
          addedAt: map.added_at,
          requiresTrigger: map.requires_trigger,
          model,
        },
      ),
      sources: parseConfiguredAgentSources(
        map.sources,
        `${pathPrefix}.sources`,
      ),
      capabilities: parseConfiguredAgentCapabilities(
        map.capabilities,
        `${pathPrefix}.capabilities`,
      ),
    };
  }
  const seenJids = new Map<string, string>();
  for (const [folder, agent] of Object.entries(result)) {
    for (const binding of Object.values(agent.bindings)) {
      const existing = seenJids.get(binding.jid);
      if (existing) {
        throw new Error(
          `agents.${folder}.bindings contains duplicate jid ${binding.jid}; already configured by agents.${existing}`,
        );
      }
      seenJids.set(binding.jid, folder);
    }
  }
  return result;
}

export function parseDesiredStateSettings(
  raw: unknown,
): RuntimeDesiredStateSettings {
  if (raw === undefined) return { authoritative: false };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('desired_state must be a mapping');
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (key !== 'authoritative') {
      throw new Error(
        `desired_state.${key} is not supported. Configure authoritative.`,
      );
    }
  }
  return {
    authoritative: parseOptionalBooleanValue(
      map.authoritative,
      'desired_state.authoritative',
      false,
    ),
  };
}
