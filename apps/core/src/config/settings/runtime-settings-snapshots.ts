import fs from 'fs';

import {
  parseRuntimeMemorySnapshotFromRoot,
  parseRuntimeStorageSnapshotFromRoot,
  type RuntimeMemorySettingsSnapshot,
  type RuntimeStorageSettingsSnapshot,
} from './memory-snapshot.js';
import { parseObserverSettings } from './runtime-settings-observer-parser.js';
import type { RuntimeObserverSettings } from './runtime-settings-types.js';
import { settingsFilePath } from './runtime-home.js';
import { parseSimpleYamlObject } from './yaml.js';

function readRuntimeSettingsRoot(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = raw.trimStart().startsWith('{')
    ? (JSON.parse(raw) as unknown)
    : (parseSimpleYamlObject(raw) as unknown);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('root must be a mapping');
  }
  return parsed as Record<string, unknown>;
}

export function readRuntimeMemorySettingsSnapshot(
  runtimeHome: string,
): RuntimeMemorySettingsSnapshot {
  const filePath = settingsFilePath(runtimeHome);
  if (!fs.existsSync(filePath)) return {};
  return parseRuntimeMemorySnapshotFromRoot(readRuntimeSettingsRoot(filePath));
}

export function readRuntimeObserverSettingsSnapshot(
  runtimeHome: string,
): RuntimeObserverSettings {
  const filePath = settingsFilePath(runtimeHome);
  if (!fs.existsSync(filePath)) return { enabled: false };
  return parseObserverSettings(readRuntimeSettingsRoot(filePath).observer);
}

export function readRuntimeStorageSettingsSnapshot(
  runtimeHome: string,
): RuntimeStorageSettingsSnapshot {
  const filePath = settingsFilePath(runtimeHome);
  if (!fs.existsSync(filePath)) {
    throw new Error(`settings file is missing at ${filePath}`);
  }
  return parseRuntimeStorageSnapshotFromRoot(readRuntimeSettingsRoot(filePath));
}
