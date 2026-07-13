import fs from 'node:fs';

import { GANTRY_HOME } from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import '../channels/register-builtins.js';
import { loadRuntimeSettingsFromPath } from '../config/settings/runtime-settings.js';
import type { SenderControlAllowlistConfig } from '../config/settings/control-allowlist.js';
import type {
  ChatAllowlistEntry,
  SenderAllowlistConfig,
} from '../config/settings/sender-allowlist.js';
import { jidForProviderExternalId } from '../config/settings/desired-state-provider-conversations.js';
import { settingsFilePath } from '../config/settings/runtime-home.js';
import {
  listChannelProviders,
  providerForJid,
} from '../channels/provider-registry.js';

export type RuntimeSenderProviderAllowlistConfig = SenderAllowlistConfig & {
  conversations?: Record<string, Record<string, ChatAllowlistEntry>>;
};
export type RuntimeSenderAllowlistConfig = Record<
  string,
  RuntimeSenderProviderAllowlistConfig
>;
export type RuntimeSenderControlProviderAllowlistConfig =
  SenderControlAllowlistConfig & {
    conversations?: Record<string, Record<string, string[]>>;
  };
export type RuntimeSenderControlAllowlistConfig = Record<
  string,
  RuntimeSenderControlProviderAllowlistConfig
>;

interface AllowlistDesiredState {
  providerAccounts: Record<string, { provider: string }>;
  conversations: Record<
    string,
    {
      providerAccount: string;
      externalId: string;
      senderPolicy: ChatAllowlistEntry;
      controlApprovers: string[];
    }
  >;
  bindings: Record<string, { agent: string; conversation: string }>;
}

interface CachedRuntimeAllowlists {
  mtimeMs: number;
  size: number;
  settings: AllowlistDesiredState;
  sender?: RuntimeSenderAllowlistConfig;
  control?: RuntimeSenderControlAllowlistConfig;
}

const allowlistCache = new Map<string, CachedRuntimeAllowlists>();

export function invalidateSenderAllowlistCache(filePath?: string): void {
  if (filePath) {
    allowlistCache.delete(filePath);
    return;
  }
  allowlistCache.clear();
}

const DEFAULT_CHANNEL_CONFIG: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  agents: {},
  logDenied: true,
};
const DEFAULT_CONTROL_CHANNEL_CONFIG: SenderControlAllowlistConfig = {
  default: [],
  agents: {},
};

const DEFAULT_ENTRY: ChatAllowlistEntry = {
  allow: [],
  mode: 'drop',
};

function cloneDefaultChannelConfig(): RuntimeSenderProviderAllowlistConfig {
  return {
    default: { ...DEFAULT_CHANNEL_CONFIG.default },
    agents: {},
    conversations: {},
    logDenied: DEFAULT_CHANNEL_CONFIG.logDenied,
  };
}

function createDefaultConfig(): RuntimeSenderAllowlistConfig {
  const cfg: RuntimeSenderAllowlistConfig = {};
  for (const provider of listChannelProviders()) {
    cfg[provider.id] = cloneDefaultChannelConfig();
  }
  return cfg;
}

function cloneDefaultControlChannelConfig(): RuntimeSenderControlProviderAllowlistConfig {
  return {
    default: [...DEFAULT_CONTROL_CHANNEL_CONFIG.default],
    agents: {},
    conversations: {},
  };
}

function createDefaultControlConfig(): RuntimeSenderControlAllowlistConfig {
  const cfg: RuntimeSenderControlAllowlistConfig = {};
  for (const provider of listChannelProviders()) {
    cfg[provider.id] = cloneDefaultControlChannelConfig();
  }
  return cfg;
}

function deriveSenderAllowlistFromSettings(
  settings: AllowlistDesiredState,
): RuntimeSenderAllowlistConfig {
  const sender = createDefaultConfig();

  for (const binding of Object.values(settings.bindings)) {
    const conversation = settings.conversations[binding.conversation];
    if (!conversation) continue;
    const connection = settings.providerAccounts[conversation.providerAccount];
    if (!connection) continue;
    const providerId = connection.provider;
    sender[providerId] ??= cloneDefaultChannelConfig();
    const conversationJid = jidForSettingsConversation(
      providerId,
      conversation.externalId,
    );
    sender[providerId].conversations ??= {};
    sender[providerId].conversations[conversationJid] ??= {};
    sender[providerId].conversations[conversationJid][binding.agent] =
      conversation.senderPolicy;
  }

  return sender;
}

function deriveControlAllowlistFromSettings(
  settings: AllowlistDesiredState,
): RuntimeSenderControlAllowlistConfig {
  const control = createDefaultControlConfig();

  for (const binding of Object.values(settings.bindings)) {
    const conversation = settings.conversations[binding.conversation];
    if (!conversation) continue;
    const connection = settings.providerAccounts[conversation.providerAccount];
    if (!connection) continue;
    const providerId = connection.provider;
    control[providerId] ??= cloneDefaultControlChannelConfig();
    const conversationJid = jidForSettingsConversation(
      providerId,
      conversation.externalId,
    );
    control[providerId].conversations ??= {};
    control[providerId].conversations[conversationJid] ??= {};
    control[providerId].conversations[conversationJid][binding.agent] =
      conversation.controlApprovers;
  }

  return control;
}

function cachedSettings(filePath: string): {
  settings: AllowlistDesiredState;
  cache: CachedRuntimeAllowlists;
} {
  const stat = fs.statSync(filePath);
  const existing = allowlistCache.get(filePath);
  if (
    existing &&
    existing.mtimeMs === stat.mtimeMs &&
    existing.size === stat.size
  ) {
    return {
      settings: existing.settings,
      cache: existing,
    };
  }
  const settings = loadRuntimeSettingsFromPath(filePath);
  const cache: CachedRuntimeAllowlists = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    settings,
  };
  allowlistCache.set(filePath, cache);
  return { settings, cache };
}

function getProviderAllowlistConfig(
  chatJid: string,
  cfg: RuntimeSenderAllowlistConfig,
): RuntimeSenderProviderAllowlistConfig | undefined {
  const providerId = providerForJid(chatJid)?.id;
  if (!providerId) return undefined;
  return cfg[providerId];
}

function getControlProviderAllowlistConfig(
  chatJid: string,
  cfg: RuntimeSenderControlAllowlistConfig,
): RuntimeSenderControlProviderAllowlistConfig | undefined {
  const providerId = providerForJid(chatJid)?.id;
  if (!providerId) return undefined;
  return cfg[providerId];
}

function jidForSettingsConversation(
  providerId: string,
  externalId: string,
): string {
  return jidForProviderExternalId(providerId, externalId);
}

export function loadSenderAllowlist(
  settingsPathOverride?: string,
): RuntimeSenderAllowlistConfig {
  const filePath = settingsPathOverride ?? settingsFilePath(GANTRY_HOME);

  try {
    const { settings, cache } = cachedSettings(filePath);
    cache.sender ??= deriveSenderAllowlistFromSettings(settings);
    return cache.sender;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return createDefaultConfig();
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        path: filePath,
      },
      'sender-allowlist: invalid settings.yaml; using defaults',
    );
    return createDefaultConfig();
  }
}

export function loadSenderControlAllowlist(
  settingsPathOverride?: string,
): RuntimeSenderControlAllowlistConfig {
  const filePath = settingsPathOverride ?? settingsFilePath(GANTRY_HOME);

  try {
    const { settings, cache } = cachedSettings(filePath);
    cache.control ??= deriveControlAllowlistFromSettings(settings);
    return cache.control;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return createDefaultControlConfig();
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        path: filePath,
      },
      'sender-control-allowlist: invalid settings.yaml; using defaults',
    );
    return createDefaultControlConfig();
  }
}

function getEntry(
  chatJid: string,
  cfg: RuntimeSenderAllowlistConfig,
  agentFolder?: string,
): ChatAllowlistEntry {
  const providerCfg = getProviderAllowlistConfig(chatJid, cfg);
  if (!providerCfg) return DEFAULT_ENTRY;
  if (agentFolder) {
    const byConversation = providerCfg.conversations?.[chatJid]?.[agentFolder];
    if (byConversation) return byConversation;
    const byAgent = providerCfg.agents[agentFolder];
    if (byAgent) return byAgent;
  }
  return providerCfg.default;
}

function getControlSenders(
  chatJid: string,
  cfg: RuntimeSenderControlAllowlistConfig,
  agentFolder?: string,
): string[] {
  const providerCfg = getControlProviderAllowlistConfig(chatJid, cfg);
  if (!providerCfg) return [];
  if (agentFolder) {
    const byConversation = providerCfg.conversations?.[chatJid]?.[agentFolder];
    if (byConversation) return byConversation;
    const byAgent = providerCfg.agents[agentFolder];
    if (byAgent) return byAgent;
  }
  return providerCfg.default;
}

export function isSenderAllowed(
  chatJid: string,
  sender: string,
  cfg: RuntimeSenderAllowlistConfig,
  agentFolder?: string,
): boolean {
  const entry = getEntry(chatJid, cfg, agentFolder);
  if (entry.allow === '*') return true;
  return entry.allow.includes(sender);
}

export function isSenderExplicitlyAllowed(
  chatJid: string,
  sender: string,
  cfg: RuntimeSenderAllowlistConfig,
  agentFolder?: string,
): boolean {
  const entry = getEntry(chatJid, cfg, agentFolder);
  if (entry.allow === '*') return false;
  return entry.allow.includes(sender);
}

export function isSenderControlAllowed(
  chatJid: string,
  sender: string,
  cfg: RuntimeSenderControlAllowlistConfig,
  agentFolder?: string,
): boolean {
  return getControlSenders(chatJid, cfg, agentFolder).includes(sender);
}

export function shouldDropMessage(
  chatJid: string,
  cfg: RuntimeSenderAllowlistConfig,
  agentFolder?: string,
): boolean {
  return getEntry(chatJid, cfg, agentFolder).mode === 'drop';
}

export function isTriggerAllowed(
  chatJid: string,
  sender: string,
  cfg: RuntimeSenderAllowlistConfig,
  agentFolder?: string,
): boolean {
  const allowed = isSenderAllowed(chatJid, sender, cfg, agentFolder);
  if (!allowed && shouldLogDenied(chatJid, cfg)) {
    logger.debug(
      { chatJid, sender, agentFolder },
      'sender-allowlist: trigger denied for sender',
    );
  }
  return allowed;
}

export function shouldLogDenied(
  chatJid: string,
  cfg: RuntimeSenderAllowlistConfig,
): boolean {
  return getProviderAllowlistConfig(chatJid, cfg)?.logDenied ?? true;
}
