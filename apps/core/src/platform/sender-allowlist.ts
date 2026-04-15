import { AGENT_ROOT } from '../core/config.js';
import { logger } from '../core/logger.js';
import {
  ChatAllowlistEntry,
  RuntimeChannel,
  SenderAllowlistConfig,
  loadRuntimeSettingsFromPath,
} from '../cli/runtime-settings.js';
import { settingsFilePath } from '../cli/runtime-home.js';

export interface RuntimeSenderAllowlistConfig {
  telegram: SenderAllowlistConfig;
  slack: SenderAllowlistConfig;
}

const DEFAULT_CHANNEL_CONFIG: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  agents: {},
  logDenied: true,
};

const DEFAULT_CONFIG: RuntimeSenderAllowlistConfig = {
  telegram: { ...DEFAULT_CHANNEL_CONFIG, agents: {} },
  slack: { ...DEFAULT_CHANNEL_CONFIG, agents: {} },
};

const DEFAULT_ENTRY: ChatAllowlistEntry = {
  allow: '*',
  mode: 'trigger',
};

function channelFromJid(chatJid: string): RuntimeChannel | undefined {
  if (chatJid.startsWith('tg:')) return 'telegram';
  if (chatJid.startsWith('sl:')) return 'slack';
  return undefined;
}

function getChannelConfig(
  chatJid: string,
  cfg: RuntimeSenderAllowlistConfig,
): SenderAllowlistConfig | undefined {
  const channel = channelFromJid(chatJid);
  if (!channel) return undefined;
  return cfg[channel];
}

export function loadSenderAllowlist(
  settingsPathOverride?: string,
): RuntimeSenderAllowlistConfig {
  const filePath = settingsPathOverride ?? settingsFilePath(AGENT_ROOT);

  try {
    const settings = loadRuntimeSettingsFromPath(filePath);
    return {
      telegram: settings.channels.telegram.senderAllowlist,
      slack: settings.channels.slack.senderAllowlist,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return DEFAULT_CONFIG;
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        path: filePath,
      },
      'sender-allowlist: invalid settings.yaml; using defaults',
    );
    return DEFAULT_CONFIG;
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
