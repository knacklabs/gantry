import fs from 'fs';
import { createHash } from 'node:crypto';
import path from 'path';

import {
  getProvider,
  providerForJid,
} from '../../channels/provider-registry.js';
import { isValidGroupFolder } from '../../platform/group-folder-rules.js';
import type { AgentPersona } from '../../shared/agent-persona.js';
import { ensureRuntimeLayout, settingsFilePath } from './runtime-home.js';
import {
  applyModelPreset,
  applyPresetManagedMemoryDefaults,
  createDefaultRuntimeSettings,
  getPresetManagedMemoryDefaults,
} from './runtime-settings-defaults.js';
import { parseRuntimeSettings } from './runtime-settings-parser.js';
import { renderRuntimeSettingsYaml } from './runtime-settings-renderer.js';
import {
  readRuntimeMemorySettingsSnapshot,
  readRuntimeStorageSettingsSnapshot,
} from './runtime-settings-snapshots.js';
import {
  runtimeSettingsValidationError,
  validateLoadedRuntimeSettings,
} from './runtime-settings-validation.js';
import type {
  RuntimeSettings,
  RuntimeSettingsValidationResult,
} from './runtime-settings-types.js';
import { validateReadableAgentToolRule } from '../../shared/agent-tool-references.js';
import { nowIso, nowMs as currentTimeMs } from '../../shared/time/datetime.js';

const DEFAULT_PROVIDER_CONNECTION_IDS: Record<string, string> = {
  app: 'app_default',
  slack: 'slack_default',
  teams: 'teams_default',
  telegram: 'telegram_default',
};

const DEFAULT_RUNTIME_SECRET_REFS: Record<string, Record<string, string>> = {
  slack: {
    bot_token: 'SLACK_BOT_TOKEN',
    app_token: 'SLACK_APP_TOKEN',
  },
  teams: {
    client_id: 'TEAMS_CLIENT_ID',
    client_secret: 'TEAMS_CLIENT_SECRET',
    tenant_id: 'TEAMS_TENANT_ID',
  },
  telegram: {
    bot_token: 'TELEGRAM_BOT_TOKEN',
  },
};

export type {
  EmbeddingProviderName,
  MemoryModelTask,
  RuntimeMemoryLlmModels,
  RuntimeMemorySettings,
  RuntimeMemorySettingsSnapshot,
  RuntimeSettings,
  RuntimeSettingsValidationFailure,
  RuntimeSettingsValidationResult,
  RuntimeStorageSettings,
  RuntimeStorageSettingsSnapshot,
} from './runtime-settings-types.js';

export {
  applyModelPreset,
  applyPresetManagedMemoryDefaults,
  createDefaultRuntimeSettings,
  getPresetManagedMemoryDefaults,
  parseRuntimeSettings,
  readRuntimeMemorySettingsSnapshot,
  readRuntimeStorageSettingsSnapshot,
};

export interface EnsureConfiguredConversationBindingInput {
  agentId: string;
  agentName: string;
  agentFolder: string;
  jid: string;
  displayName: string;
  trigger: string;
  requiresTrigger: boolean;
  persona?: AgentPersona;
  approverIds?: string[];
}

export function saveRuntimeSettings(
  runtimeHome: string,
  settings: RuntimeSettings,
): void {
  writeSettingsYamlAtomic(
    settingsFilePath(runtimeHome),
    renderRuntimeSettingsYaml(settings),
  );
}

export function mirrorAgentToolRulesToRuntimeSettings(input: {
  runtimeHome: string;
  agentFolder: string;
  rules: readonly string[];
  mode?: 'add' | 'remove';
}): void {
  const settings = loadRuntimeSettings(input.runtimeHome);
  if (input.mode === 'remove') {
    removeAgentToolRulesFromRuntimeSettings(
      settings,
      input.agentFolder,
      input.rules,
    );
  } else {
    addAgentToolRulesToRuntimeSettings(
      settings,
      input.agentFolder,
      input.rules,
    );
  }
  saveRuntimeSettings(input.runtimeHome, settings);
}

export function addAgentToolRulesToRuntimeSettings(
  settings: RuntimeSettings,
  agentFolder: string,
  rules: readonly string[],
): void {
  const folder = agentFolder.trim();
  const agent = settings.agents[folder];
  if (!agent) {
    throw new Error(
      `Cannot mirror persistent tool rules for missing settings agent: ${folder || '(empty)'}`,
    );
  }
  const next = new Set<string>();
  for (const existing of agent.capabilities) {
    const readable = capabilityToToolRule(existing.id);
    if (!readable) continue;
    const validation = validateReadableAgentToolRule(readable);
    if (!validation.ok) throw new Error(validation.reason);
    next.add(readable);
  }
  for (const rule of rules) {
    const readable = rule.trim();
    const validation = validateReadableAgentToolRule(readable);
    if (!validation.ok) throw new Error(validation.reason);
    if (readable) next.add(readable);
  }
  agent.capabilities = [...next].map(toolRuleToCapability);
}

export function removeAgentToolRulesFromRuntimeSettings(
  settings: RuntimeSettings,
  agentFolder: string,
  rules: readonly string[],
): void {
  const folder = agentFolder.trim();
  const agent = settings.agents[folder];
  if (!agent) {
    throw new Error(
      `Cannot mirror persistent tool rule removal for missing settings agent: ${folder || '(empty)'}`,
    );
  }
  const remove = new Set<string>();
  for (const rule of rules) {
    const readable = rule.trim();
    const validation = validateReadableAgentToolRule(readable);
    if (!validation.ok) throw new Error(validation.reason);
    if (readable) remove.add(readable);
  }
  agent.capabilities = agent.capabilities.filter((capability) => {
    const readable = capabilityToToolRule(capability.id);
    if (!readable) return false;
    const validation = validateReadableAgentToolRule(readable);
    if (!validation.ok) throw new Error(validation.reason);
    return !remove.has(readable);
  });
}

export function capabilityToToolRule(capabilityId: string): string {
  const id = capabilityId.trim();
  if (id === 'browser.use') return 'Browser';
  if (id.includes('.') && !id.startsWith('RunCommand(')) {
    return `capability:${id}`;
  }
  return id;
}

function toolRuleToCapability(rule: string): { id: string; version: string } {
  if (rule === 'Browser') return { id: 'browser.use', version: 'builtin' };
  if (rule.startsWith('capability:')) {
    return { id: rule.slice('capability:'.length), version: 'builtin' };
  }
  return { id: rule, version: 'builtin' };
}

function writeSettingsYamlAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${currentTimeMs()}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, content, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } finally {
    if (fs.existsSync(tmpPath)) {
      fs.rmSync(tmpPath, { force: true });
    }
  }
}

export function readRuntimeSettingsYaml(runtimeHome: string): string {
  const filePath = settingsFilePath(runtimeHome);
  if (!fs.existsSync(filePath)) {
    return renderRuntimeSettingsYaml(createDefaultRuntimeSettings());
  }
  return fs.readFileSync(filePath, 'utf-8');
}

export function getRuntimeSettingsRevision(runtimeHome: string): string {
  return `sha256:${createHash('sha256')
    .update(readRuntimeSettingsYaml(runtimeHome))
    .digest('hex')}`;
}

export function addControlSenderForAgent(
  settings: RuntimeSettings,
  providerId: string,
  folder: string,
  sender: string,
): boolean {
  const trimmedFolder = folder.trim();
  const trimmedSender = sender.trim();
  if (!isValidGroupFolder(trimmedFolder)) {
    throw new Error(`Invalid agent folder for control allowlist: ${folder}`);
  }
  if (!trimmedSender) {
    return false;
  }

  let changed = false;
  for (const [conversationId, conversation] of Object.entries(
    settings.conversations,
  )) {
    const connection =
      settings.providerConnections[conversation.providerConnection];
    if (connection?.provider !== providerId) continue;
    const binding = Object.values(settings.bindings).find(
      (candidate) =>
        candidate.agent === trimmedFolder &&
        candidate.conversation === conversationId,
    );
    if (!binding) continue;
    if (!conversation.controlApprovers.includes(trimmedSender)) {
      conversation.controlApprovers = [
        ...conversation.controlApprovers,
        trimmedSender,
      ].sort();
      changed = true;
    }
  }
  return changed;
}

export function ensureConfiguredConversationBinding(
  settings: RuntimeSettings,
  input: EnsureConfiguredConversationBindingInput,
): {
  providerId: string;
  providerConnectionId: string;
  conversationId: string;
  bindingId: string;
} {
  const provider = providerForJid(input.jid);
  if (!provider) {
    throw new Error(`Unsupported provider for conversation id: ${input.jid}`);
  }
  const providerConnectionId =
    settings.providers[provider.id]?.defaultConnection ||
    DEFAULT_PROVIDER_CONNECTION_IDS[provider.id] ||
    `${provider.id}_default`;
  settings.providers[provider.id] = {
    enabled: true,
    defaultConnection: providerConnectionId,
  };
  settings.providerConnections[providerConnectionId] ??= {
    provider: provider.id,
    label: `${provider.label} Default`,
    runtimeSecretRefs: { ...(DEFAULT_RUNTIME_SECRET_REFS[provider.id] || {}) },
  };

  const agentId = input.agentId.trim();
  const folder = input.agentFolder.trim();
  if (!isValidGroupFolder(agentId)) {
    throw new Error(`Invalid agent id for settings: ${agentId}`);
  }
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid agent folder for settings: ${folder}`);
  }
  settings.agents[agentId] ??= {
    name: input.agentName.trim() || settings.agent.name,
    folder,
    persona: input.persona ?? 'developer',
    bindings: {},
    sources: { skills: [], mcpServers: [], tools: [] },
    capabilities: [],
  };

  const externalId = stripProviderPrefix(input.jid, provider.id);
  const conversationId = configuredConversationId({
    providerConnectionId,
    externalId,
    conversations: settings.conversations,
  });
  const existingConversation = settings.conversations[conversationId];
  const controlApprovers = [
    ...new Set([
      ...(existingConversation?.controlApprovers || []),
      ...(input.approverIds || []),
    ]),
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
  settings.conversations[conversationId] = {
    providerConnection: providerConnectionId,
    externalId,
    kind: provider.isGroupJid(input.jid) ? 'channel' : 'dm',
    displayName: input.displayName.trim() || input.jid,
    senderPolicy: existingConversation?.senderPolicy || {
      allow: '*',
      mode: 'trigger',
    },
    controlApprovers,
  };

  const bindingId = stableSettingsId(
    `${agentId}_${conversationId}`,
    settings.bindings,
    `${agentId}:${conversationId}`,
  );
  const existingBinding = settings.bindings[bindingId];
  settings.bindings[bindingId] = {
    agent: agentId,
    conversation: conversationId,
    trigger: input.trigger,
    addedAt: existingBinding?.addedAt || nowIso(),
    requiresTrigger: input.requiresTrigger,
    memoryScope: existingBinding?.memoryScope || 'conversation',
    model: existingBinding?.model,
  };
  settings.agents[agentId].bindings[bindingId] = {
    jid: input.jid,
    provider: provider.id,
    name: input.displayName,
    trigger: input.trigger,
    addedAt: settings.bindings[bindingId].addedAt,
    requiresTrigger: input.requiresTrigger,
    model: settings.bindings[bindingId].model ?? settings.agents[agentId].model,
  };

  return {
    providerId: provider.id,
    providerConnectionId,
    conversationId,
    bindingId,
  };
}

function stripProviderPrefix(jid: string, providerId: string): string {
  const provider = getProvider(providerId);
  return provider && jid.startsWith(provider.jidPrefix)
    ? jid.slice(provider.jidPrefix.length)
    : jid;
}

function configuredConversationId(input: {
  providerConnectionId: string;
  externalId: string;
  conversations: RuntimeSettings['conversations'];
}): string {
  const existing = Object.entries(input.conversations).find(
    ([, conversation]) =>
      conversation.providerConnection === input.providerConnectionId &&
      conversation.externalId === input.externalId,
  );
  if (existing) return existing[0];
  return stableSettingsId(
    `${input.providerConnectionId}_${input.externalId}`,
    input.conversations,
    `${input.providerConnectionId}:${input.externalId}`,
  );
}

function stableSettingsId(
  value: string,
  existing: Record<string, unknown> = {},
  discriminator = value,
): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const base = normalized || 'item';
  if (!Object.hasOwn(existing, base)) return base;
  const hash = createHash('sha256').update(discriminator).digest('hex');
  for (let length = 12; length <= 64; length += 8) {
    const candidate = `${base}_${hash.slice(0, length)}`.slice(0, 96);
    if (!Object.hasOwn(existing, candidate)) return candidate;
  }
  return `${base}_${currentTimeMs()}`.slice(0, 96);
}

export function loadRuntimeSettingsFromPath(filePath: string): RuntimeSettings {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseRuntimeSettings(raw);
}

function ensureRuntimeSettingsLoaded(runtimeHome: string): {
  settings: RuntimeSettings;
  filePath: string;
} {
  ensureRuntimeLayout(runtimeHome);
  const filePath = settingsFilePath(runtimeHome);
  if (!fs.existsSync(filePath)) {
    const defaults = createDefaultRuntimeSettings();
    saveRuntimeSettings(runtimeHome, defaults);
    return { settings: defaults, filePath };
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const settings = parseRuntimeSettings(raw);
  return { settings, filePath };
}

export function ensureRuntimeSettings(runtimeHome: string): RuntimeSettings {
  return ensureRuntimeSettingsLoaded(runtimeHome).settings;
}

export function loadRuntimeSettings(runtimeHome: string): RuntimeSettings {
  return ensureRuntimeSettingsLoaded(runtimeHome).settings;
}

export function validateRuntimeSettings(
  runtimeHome: string,
): RuntimeSettingsValidationResult {
  try {
    const { settings } = ensureRuntimeSettingsLoaded(runtimeHome);
    return validateLoadedRuntimeSettings(runtimeHome, settings);
  } catch (err) {
    return runtimeSettingsValidationError(runtimeHome, err);
  }
}
