import fs from 'fs';
import os from 'os';
import path from 'path';
import { getGantryHome } from '../../shared/gantry-home.js';
import { ensureRuntimeLayoutDirectories } from '../../platform/runtime-layout.js';
export const DEFAULT_RUNTIME_HOME = path.join(os.homedir(), 'gantry');
export function resolveRuntimeHome(raw) {
    const source = raw?.trim() || process.env.GANTRY_HOME?.trim() || DEFAULT_RUNTIME_HOME;
    return getGantryHome(source);
}
export function ensureRuntimeLayout(runtimeHome) {
    ensureRuntimeLayoutDirectories(runtimeHome);
}
export function ensureRuntimeWritable(runtimeHome) {
    ensureRuntimeLayout(runtimeHome);
    fs.accessSync(runtimeHome, fs.constants.W_OK);
}
export function envFilePath(runtimeHome) {
    return path.join(runtimeHome, '.env');
}
export function settingsFilePath(runtimeHome) {
    return path.join(runtimeHome, 'settings.yaml');
}
export function onboardingStatePath(runtimeHome) {
    return path.join(runtimeHome, '.onboarding-state.json');
}
export function runtimeLogPath(runtimeHome) {
    return path.join(runtimeHome, 'logs', 'gantry.log');
}
export function runtimeErrorLogPath(runtimeHome) {
    return path.join(runtimeHome, 'logs', 'gantry.error.log');
}
