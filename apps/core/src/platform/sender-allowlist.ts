import { MYCLAW_HOME } from '../core/config.js';
import { logger } from '../core/logger.js';
import '../channels/register-builtins.js';
import {
  ChatAllowlistEntry,
  SenderAllowlistConfig,
  loadRuntimeSettingsFromPath,
} from '../cli/runtime-settings.js';
import { settingsFilePath } from '../cli/runtime-home.js';
import {
  listChannelProviders,
  providerForJid,
} from '../channels/provider-registry.js';

export type RuntimeSenderAllowlistConfig = Record<
  string,
  SenderAllowlistConfig
>;

const DEFAULT_CHANNEL_CONFIG: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  agents: {},
  logDenied: true,
};

const DEFAULT_ENTRY: ChatAllowlistEntry = {
  allow: [],
  mode: 'drop',
};

function cloneDefaultChannelConfig(): SenderAllowlistConfig {
  return {
    default: { ...DEFAULT_CHANNEL_CONFIG.default },
    agents: {},
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

function getChannelConfig(
  chatJid: string,
  cfg: RuntimeSenderAllowlistConfig,
): SenderAllowlistConfig | undefined {
  const channelId = providerForJid(chatJid)?.id;
  if (!channelId) return undefined;
  return cfg[channelId];
}

export function loadSenderAllowlist(
  settingsPathOverride?: string,
): RuntimeSenderAllowlistConfig {
  const filePath = settingsPathOverride ?? settingsFilePath(MYCLAW_HOME);

  try {
    const settings = loadRuntimeSettingsFromPath(filePath);
    const cfg = createDefaultConfig();
    for (const [channelId, channelSettings] of Object.entries(
      settings.channels,
    )) {
      cfg[channelId] = channelSettings.senderAllowlist;
    }
    return cfg;
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

function getEntry(
  chatJid: string,
  cfg: RuntimeSenderAllowlistConfig,
  groupFolder?: string,
): ChatAllowlistEntry {
  const channelCfg = getChannelConfig(chatJid, cfg);
  if (!channelCfg) return DEFAULT_ENTRY;
  if (groupFolder) {
    const byAgent = channelCfg.agents[groupFolder];
    if (byAgent) return byAgent;
  }
  return channelCfg.default;
}

export function isSenderAllowed(
  chatJid: string,
  sender: string,
  cfg: RuntimeSenderAllowlistConfig,
  groupFolder?: string,
): boolean {
  const entry = getEntry(chatJid, cfg, groupFolder);
  if (entry.allow === '*') return true;
  return entry.allow.includes(sender);
}

export function isSenderExplicitlyAllowed(
  chatJid: string,
  sender: string,
  cfg: RuntimeSenderAllowlistConfig,
  groupFolder?: string,
): boolean {
  const entry = getEntry(chatJid, cfg, groupFolder);
  if (entry.allow === '*') return false;
  return entry.allow.includes(sender);
}

export function shouldDropMessage(
  chatJid: string,
  cfg: RuntimeSenderAllowlistConfig,
  groupFolder?: string,
): boolean {
  return getEntry(chatJid, cfg, groupFolder).mode === 'drop';
}

export function isTriggerAllowed(
  chatJid: string,
  sender: string,
  cfg: RuntimeSenderAllowlistConfig,
  groupFolder?: string,
): boolean {
  const allowed = isSenderAllowed(chatJid, sender, cfg, groupFolder);
  if (!allowed && shouldLogDenied(chatJid, cfg)) {
    logger.debug(
      { chatJid, sender, groupFolder },
      'sender-allowlist: trigger denied for sender',
    );
  }
  return allowed;
}

export function shouldLogDenied(
  chatJid: string,
  cfg: RuntimeSenderAllowlistConfig,
): boolean {
  return getChannelConfig(chatJid, cfg)?.logDenied ?? true;
}
