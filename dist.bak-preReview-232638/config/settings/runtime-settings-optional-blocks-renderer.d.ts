import type { RuntimeSettings } from './runtime-settings-types.js';
export declare function quoteYamlKey(key: string): string;
export declare function renderAgentDelegatesYaml(lines: string[], delegates: string[] | undefined): void;
export declare function renderLimitsSettingsYaml(lines: string[], limits: RuntimeSettings['limits']): void;
export declare function renderObservabilitySettingsYaml(lines: string[], observability: RuntimeSettings['observability']): void;
export declare function renderObserverSettingsYaml(lines: string[], observer: RuntimeSettings['observer']): void;
export declare function renderModelFamiliesYaml(lines: string[], modelFamilies: Record<string, string[]>): void;
export declare function renderModelAliasesYaml(lines: string[], modelAliases: RuntimeSettings['modelAliases']): void;
