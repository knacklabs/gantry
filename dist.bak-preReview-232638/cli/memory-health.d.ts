import type { RuntimeSettings } from '../config/settings/runtime-settings.js';
export type HealthStatus = 'pass' | 'warn' | 'fail';
export type ConfigSource = 'settings.yaml' | 'default' | 'env' | 'derived';
export interface HealthCheckResult {
    status: HealthStatus;
    message: string;
    nextAction?: string;
}
export interface MemoryHealthInspection {
    storageProvider: 'postgres';
    memoryEnabled: boolean;
    embeddingsEnabled: boolean;
    dreamingEnabled: boolean;
    embeddingProvider: string;
    embeddingModel: string;
    memorySource: ConfigSource;
    embeddingProviderSource: ConfigSource;
    embeddingModelSource: ConfigSource;
    dreamingSource: ConfigSource;
    memoryCheck: HealthCheckResult;
    embeddingCheck: HealthCheckResult;
    warnings: HealthCheckResult[];
}
export declare function inspectMemoryHealth(_runtimeHome: string, settings: RuntimeSettings | undefined, env: Record<string, string | undefined>): MemoryHealthInspection;
