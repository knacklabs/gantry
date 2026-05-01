import fs from 'fs';

import { isValidGroupFolder } from '../../platform/group-folder-rules.js';
import { addControlSenderForAgent as addControlSenderToChannel } from './control-allowlist.js';
import { ensureRuntimeLayout, settingsFilePath } from './runtime-home.js';
import {
  applyMemoryModelProfile,
  createDefaultChannelSettings,
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

export type {
  EmbeddingProviderName,
  MemoryModelProfile,
  MemoryModelTask,
  RuntimeChannel,
  RuntimeChannelSettings,
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

export function saveRuntimeSettings(
  runtimeHome: string,
  settings: RuntimeSettings,
): void {
  fs.writeFileSync(
    settingsFilePath(runtimeHome),
    renderRuntimeSettingsYaml(settings),
    'utf-8',
  );
}

export function addControlSenderForAgent(
  settings: RuntimeSettings,
  channelId: string,
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

  const channel =
    settings.channels[channelId] || createDefaultChannelSettings(false);
  settings.channels[channelId] = channel;
  return addControlSenderToChannel(channel, trimmedFolder, trimmedSender);
}

export function inferRecoverableMainAgentJid(
  runtimeSettings: RuntimeSettings,
): string | null {
  const telegram = runtimeSettings.channels.telegram;
  if (!telegram?.enabled) return null;
  return null;
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
