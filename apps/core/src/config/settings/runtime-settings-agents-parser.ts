import { resolveModelSelection } from '../../shared/model-catalog.js';
import { parseAgentPersona } from '../../shared/agent-persona.js';
import type {
  RuntimeConfiguredAgent,
  RuntimeConfiguredAgentBinding,
  RuntimeConfiguredAgentCapabilities,
  RuntimeConfiguredAgentDmAccessEntry,
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

function parseStringArrayValue(raw: unknown, pathPrefix: string): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a string array`);
  }
  return raw.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`${pathPrefix}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

function isValidSettingsAgentFolder(folder: string): boolean {
  if (!folder || folder !== folder.trim()) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  return folder.toLowerCase() !== 'global' && folder.toLowerCase() !== 'shared';
}

function parseConfiguredAgentDmAccess(
  raw: unknown,
  pathPrefix: string,
): RuntimeConfiguredAgentDmAccessEntry[] {
  if (raw === undefined) return [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }
  const entries: RuntimeConfiguredAgentDmAccessEntry[] = [];
  for (const [provider, providerRaw] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (!/^[a-z][a-z0-9_-]{0,62}$/.test(provider)) {
      throw new Error(
        `${pathPrefix}.${provider} must use a lowercase provider id`,
      );
    }
    if (
      typeof providerRaw !== 'object' ||
      providerRaw === null ||
      Array.isArray(providerRaw)
    ) {
      throw new Error(`${pathPrefix}.${provider} must be a mapping`);
    }
    const providerMap = providerRaw as Record<string, unknown>;
    for (const key of Object.keys(providerMap)) {
      if (key !== 'allow' && key !== 'admin') {
        throw new Error(
          `${pathPrefix}.${provider}.${key} is not supported. Configure allow or admin.`,
        );
      }
    }
    const adminRaw = providerMap.admin;
    const adminUserId =
      adminRaw === undefined
        ? undefined
        : parseStringValue(adminRaw, `${pathPrefix}.${provider}.admin`);
    entries.push({
      provider,
      userIds: parseStringArrayValue(
        providerMap.allow ?? [],
        `${pathPrefix}.${provider}.allow`,
      ),
      adminUserId,
    });
  }
  return entries;
}

function parseConfiguredAgentCapabilities(
  raw: unknown,
  pathPrefix: string,
): RuntimeConfiguredAgentCapabilities {
  if (raw === undefined) {
    return { toolIds: [], skillIds: [], mcpServerIds: [] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (key !== 'tool_ids' && key !== 'skill_ids' && key !== 'mcp_server_ids') {
      throw new Error(
        `${pathPrefix}.${key} is not supported. Configure tool_ids, skill_ids, or mcp_server_ids.`,
      );
    }
  }
  return {
    toolIds: parseStringArrayValue(
      map.tool_ids ?? [],
      `${pathPrefix}.tool_ids`,
    ),
    skillIds: parseStringArrayValue(
      map.skill_ids ?? [],
      `${pathPrefix}.skill_ids`,
    ),
    mcpServerIds: parseStringArrayValue(
      map.mcp_server_ids ?? [],
      `${pathPrefix}.mcp_server_ids`,
    ),
  };
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
    isMain?: unknown;
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
          '@Main Agent',
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
        isMain: parseOptionalBooleanValue(
          fallback.isMain,
          `${pathPrefix}.primary.main`,
          false,
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
        key !== 'main' &&
        key !== 'model'
      ) {
        throw new Error(
          `${bindingPath}.${key} is not supported. Configure jid, provider, name, trigger, added_at, requires_trigger, main, or model.`,
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
      const resolved = resolveModelSelection(model);
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
      isMain: parseOptionalBooleanValue(map.main, `${bindingPath}.main`, false),
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
        key !== 'main' &&
        key !== 'model' &&
        key !== 'one_time_job_default_model' &&
        key !== 'recurring_job_default_model' &&
        key !== 'bindings' &&
        key !== 'dm_access' &&
        key !== 'capabilities'
      ) {
        throw new Error(
          `${pathPrefix}.${key} is not supported. Configure name, model, job model defaults, bindings, dm_access, or capabilities.`,
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
      const resolved = resolveModelSelection(model);
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
      const resolved = resolveModelSelection(oneTimeJobDefaultModel);
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
      const resolved = resolveModelSelection(recurringJobDefaultModel);
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
          isMain: map.main,
          model,
        },
      ),
      dmAccess: parseConfiguredAgentDmAccess(
        map.dm_access,
        `${pathPrefix}.dm_access`,
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
