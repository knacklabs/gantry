import { resolveModelSelectionForWorkload } from '../../shared/model-catalog.js';
import {
  isAgentHarness,
  type AgentHarness,
} from '../../shared/agent-engine.js';
import { parseAgentPersona } from '../../shared/agent-persona.js';
import { parseAgentRelationshipMode } from '../../shared/agent-relationship-mode.js';
import type {
  AgentAccessPreset,
  RuntimeConfiguredAgent,
  RuntimeConfiguredAgentBinding,
  RuntimeConfiguredAgentCapability,
  RuntimeConfiguredAgentSourceRef,
  RuntimeConfiguredAgentSources,
  RuntimeDesiredStateSettings,
} from './runtime-settings-types.js';
import {
  parseBooleanValue,
  parseStringArrayValue,
  parseStringValue,
} from './runtime-settings-parse-primitives.js';

function parseOptionalAgentHarnessValue(
  raw: unknown,
  pathPrefix: string,
): AgentHarness | undefined {
  if (raw === undefined) return undefined;
  if (!isAgentHarness(raw)) {
    throw new Error(
      `${pathPrefix} must be one of auto, anthropic_sdk, or deepagents`,
    );
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
    allowTools?: boolean;
  },
): RuntimeConfiguredAgentSourceRef {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }
  const map = raw as Record<string, unknown>;
  const allowVersion = options.allowVersion ?? true;
  const allowTools = options.allowTools ?? false;
  for (const key of Object.keys(map)) {
    if (
      key !== 'name' &&
      key !== 'id' &&
      key !== 'version' &&
      key !== 'kind' &&
      key !== 'tools'
    ) {
      throw new Error(
        `${pathPrefix}.${key} is not supported. Configure name, id, version, or kind.`,
      );
    }
    if (key === 'version' && !allowVersion) {
      throw new Error(
        `${pathPrefix}.version is not supported. Configure id only.`,
      );
    }
    if (key === 'tools' && !allowTools) {
      throw new Error(
        `${pathPrefix}.tools is only supported for mcp_servers sources.`,
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
  if (allowTools && map.tools !== undefined) {
    const tools = parseStringArrayValue(map.tools, `${pathPrefix}.tools`);
    if (tools.length > 0) source.tools = tools;
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
    allowTools?: boolean;
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
      { allowVersion: false, allowTools: true },
    ),
    tools: parseConfiguredAgentSourceArray(map.tools, `${pathPrefix}.tools`, {
      requireKind: true,
    }),
  };
}

function parseConfiguredAgentAccess(
  raw: unknown,
  pathPrefix: string,
): {
  sources: RuntimeConfiguredAgentSources;
  capabilities: RuntimeConfiguredAgentCapability[];
  accessPreset: AgentAccessPreset;
} {
  if (raw === undefined) {
    return {
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (key !== 'sources' && key !== 'selections' && key !== 'preset') {
      throw new Error(
        `${pathPrefix}.${key} is not supported. Configure sources, selections, or preset.`,
      );
    }
  }
  return {
    sources: parseConfiguredAgentSources(map.sources, `${pathPrefix}.sources`),
    capabilities: parseConfiguredAgentSelections(
      map.selections,
      `${pathPrefix}.selections`,
    ),
    accessPreset: parseAgentAccessPreset(map.preset, `${pathPrefix}.preset`),
  };
}

function parseAgentAccessPreset(
  raw: unknown,
  pathPrefix: string,
): AgentAccessPreset {
  if (raw === undefined) return 'full';
  const value = parseStringValue(raw, pathPrefix);
  if (value !== 'full' && value !== 'locked') {
    throw new Error(`${pathPrefix} must be full or locked`);
  }
  return value;
}

function parseConfiguredAgentSelections(
  raw: unknown,
  pathPrefix: string,
): RuntimeConfiguredAgentCapability[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `${pathPrefix} must be an array of selected access entries`,
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
        key !== 'relationship_mode' &&
        key !== 'jid' &&
        key !== 'trigger' &&
        key !== 'added_at' &&
        key !== 'requires_trigger' &&
        key !== 'model' &&
        key !== 'agent_harness' &&
        key !== 'one_time_job_default_model' &&
        key !== 'recurring_job_default_model' &&
        key !== 'bindings' &&
        key !== 'access'
      ) {
        throw new Error(
          `${pathPrefix}.${key} is not supported. Configure name, persona, relationship_mode, model, agent_harness, job model defaults, bindings, or access.`,
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
      relationshipMode: parseAgentRelationshipMode(
        map.relationship_mode,
        `${pathPrefix}.relationship_mode`,
      ),
      model,
      agentHarness: parseOptionalAgentHarnessValue(
        map.agent_harness,
        `${pathPrefix}.agent_harness`,
      ),
      oneTimeJobDefaultModel,
      recurringJobDefaultModel,
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
      ...parseConfiguredAgentAccess(map.access, `${pathPrefix}.access`),
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
