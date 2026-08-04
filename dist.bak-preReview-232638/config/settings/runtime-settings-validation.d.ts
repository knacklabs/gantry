import type { RuntimeSettings, RuntimeSettingsValidationResult } from './runtime-settings-types.js';
export declare function validateLoadedRuntimeSettings(runtimeHome: string, settings: RuntimeSettings): RuntimeSettingsValidationResult;
export declare function runtimeSettingsValidationError(runtimeHome: string, err: unknown): RuntimeSettingsValidationResult;
