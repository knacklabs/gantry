import type { RuntimeSettings } from './runtime-settings-types.js';
export declare function parseRuntimeSettings(raw: string): RuntimeSettings;
/**
 * Decode an already-parsed settings document object into typed runtime
 * settings. This is the structural-validation core shared by the YAML file edge
 * (`parseRuntimeSettings`, via `parseSimpleYamlObject`) and the typed JSON
 * settings document carried by the control API / stored in `settings_revisions`
 * (`settingsFromRevisionDocument`). Both surfaces therefore produce identical
 * document-path-level error messages (one validation path, no authority fork).
 */
export declare function parseRuntimeSettingsObject(document: Record<string, unknown>): RuntimeSettings;
