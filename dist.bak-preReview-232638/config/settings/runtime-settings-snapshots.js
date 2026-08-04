import fs from 'fs';
import { parseRuntimeMemorySnapshotFromRoot, parseRuntimeStorageSnapshotFromRoot, } from './memory-snapshot.js';
import { parseObserverSettings } from './runtime-settings-observer-parser.js';
import { settingsFilePath } from './runtime-home.js';
import { parseSimpleYamlObject } from './yaml.js';
function readRuntimeSettingsRoot(filePath) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = raw.trimStart().startsWith('{')
        ? JSON.parse(raw)
        : parseSimpleYamlObject(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('root must be a mapping');
    }
    return parsed;
}
export function readRuntimeMemorySettingsSnapshot(runtimeHome) {
    const filePath = settingsFilePath(runtimeHome);
    if (!fs.existsSync(filePath))
        return {};
    return parseRuntimeMemorySnapshotFromRoot(readRuntimeSettingsRoot(filePath));
}
export function readRuntimeObserverSettingsSnapshot(runtimeHome) {
    const filePath = settingsFilePath(runtimeHome);
    if (!fs.existsSync(filePath))
        return { enabled: false };
    return parseObserverSettings(readRuntimeSettingsRoot(filePath).observer);
}
export function readRuntimeStorageSettingsSnapshot(runtimeHome) {
    const filePath = settingsFilePath(runtimeHome);
    if (!fs.existsSync(filePath)) {
        throw new Error(`settings file is missing at ${filePath}`);
    }
    return parseRuntimeStorageSnapshotFromRoot(readRuntimeSettingsRoot(filePath));
}
