import path from 'node:path';

import { parseAgentPersona } from '../../shared/agent-persona.js';
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
  RuntimeDesiredStateSettings,
} from './runtime-settings-types.js';

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
    if (key !== 'file' && key !== 'model') {
      throw new Error(
        `${pathPrefix}.${key} is not supported. Configure file or model.`,
      );
    }
  }
  const file = parsePluginRelativePath(map.file, `${pathPrefix}.file`);
  const model = parseStringValue(map.model, `${pathPrefix}.model`);
  const resolved = resolveModelSelection(model);
  if (!resolved.ok) {
    throw new Error(`${pathPrefix}.model is invalid: ${resolved.message}`);
  }
  return { file, model };
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
      key !== 'skills'
    ) {
      throw new Error(
        `${pathPrefix}.${key} is not supported. Configure guardrail, memory_extraction, or skills.`,
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
        key !== 'bindings' &&
        key !== 'sources' &&
        key !== 'capabilities'
      ) {
        throw new Error(
          `${pathPrefix}.${key} is not supported. Configure name, persona, model, job model defaults, thinking, plugins (guardrail/memory_extraction/skills), memory (idle_end_minutes), bindings, sources, or capabilities.`,
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
