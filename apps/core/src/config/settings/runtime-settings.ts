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
  applyMemoryModelProfile,
  createDefaultRuntimeSettings,
  getMemoryModelProfileDefaults,
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
  MemoryModelProfile,
  RuntimeSettings,
  RuntimeSettingsValidationResult,
} from './runtime-settings-types.js';

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
  MemoryModelProfile,
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
  applyMemoryModelProfile,
  createDefaultRuntimeSettings,
  getMemoryModelProfileDefaults,
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
  isMain: boolean;
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

function writeSettingsYamlAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
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

export function inferRecoverableMainAgentJid(
  runtimeSettings: RuntimeSettings,
): string | null {
  const telegram = runtimeSettings.providers?.telegram;
  if (!telegram?.enabled) return null;
  return null;
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
    dmAccess: [],
    capabilities: {
      toolIds: [],
      skillIds: [],
      mcpServerIds: [],
    },
  };
  seedAgentDmAdminFromApprovers(settings.agents[agentId], provider.id, [
    ...(input.approverIds || []),
  ]);

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
    addedAt: existingBinding?.addedAt || new Date().toISOString(),
    requiresTrigger: input.requiresTrigger,
    isMain: input.isMain,
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
    isMain: input.isMain,
    model: settings.bindings[bindingId].model ?? settings.agents[agentId].model,
  };

  return {
    providerId: provider.id,
    providerConnectionId,
    conversationId,
    bindingId,
  };
}

function seedAgentDmAdminFromApprovers(
  agent: RuntimeSettings['agents'][string],
  providerId: string,
  approverIds: string[],
): void {
  const userIds = [
    ...new Set(approverIds.map((value) => value.trim()).filter(Boolean)),
  ];
  if (userIds.length === 0) return;

  const existing = agent.dmAccess.find(
    (entry) => entry.provider === providerId,
  );
  if (existing) {
    existing.userIds = [...new Set([...existing.userIds, ...userIds])].sort();
    existing.adminUserId ??= userIds[0];
    return;
  }

  agent.dmAccess.push({
    provider: providerId,
    userIds,
    adminUserId: userIds[0],
  });
  agent.dmAccess.sort((a, b) => a.provider.localeCompare(b.provider));
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
  return `${base}_${Date.now()}`.slice(0, 96);
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

export type { MemoryModelProfile as RuntimeSettingsMemoryModelProfile };
