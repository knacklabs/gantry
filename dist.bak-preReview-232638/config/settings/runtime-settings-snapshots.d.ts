import { type RuntimeMemorySettingsSnapshot, type RuntimeStorageSettingsSnapshot } from './memory-snapshot.js';
import type { RuntimeObserverSettings } from './runtime-settings-types.js';
export declare function readRuntimeMemorySettingsSnapshot(runtimeHome: string): RuntimeMemorySettingsSnapshot;
export declare function readRuntimeObserverSettingsSnapshot(runtimeHome: string): RuntimeObserverSettings;
export declare function readRuntimeStorageSettingsSnapshot(runtimeHome: string): RuntimeStorageSettingsSnapshot;
