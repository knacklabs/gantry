import { AGENT_ROOT } from '../core/config.js';
import { logger } from '../core/logger.js';
import {
  ChatAllowlistEntry,
  loadRuntimeSettingsFromPath,
  SenderAllowlistConfig,
} from '../cli/runtime-settings.js';
import { settingsFilePath } from '../cli/runtime-home.js';

const DEFAULT_CONFIG: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  chats: {},
  logDenied: true,
};

export function loadSenderAllowlist(
  settingsPathOverride?: string,
): SenderAllowlistConfig {
  const filePath = settingsPathOverride ?? settingsFilePath(AGENT_ROOT);

  try {
    const settings = loadRuntimeSettingsFromPath(filePath);
    return settings.messagePolicy.senderAllowlist;
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
  cfg: SenderAllowlistConfig,
): ChatAllowlistEntry {
  return cfg.chats[chatJid] ?? cfg.default;
}

export function isSenderAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const entry = getEntry(chatJid, cfg);
  if (entry.allow === '*') return true;
  return entry.allow.includes(sender);
}

export function shouldDropMessage(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): boolean {
  return getEntry(chatJid, cfg).mode === 'drop';
}

export function isTriggerAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const allowed = isSenderAllowed(chatJid, sender, cfg);
  if (!allowed && cfg.logDenied) {
    logger.debug(
      { chatJid, sender },
      'sender-allowlist: trigger denied for sender',
    );
  }
  return allowed;
}
