import { type ModelCatalogEntry, type ModelWorkload } from '../../shared/model-catalog.js';
import type { AppId } from '../../domain/app/app.js';
export type RuntimeModelDefaultConfig = {
    model?: string;
    source: string;
};
export type RuntimeModelDefaultKind = 'interactive' | 'oneTimeJob' | 'recurringJob';
export type RuntimeModelDefaultResolver = (kind?: RuntimeModelDefaultKind, agentFolder?: string) => RuntimeModelDefaultConfig;
export type RuntimeModelDefaultSlot = {
    configuredAlias: string | null;
    effectiveAlias: string | null;
    source: string;
    workload: ModelWorkload;
    modelEntry: ModelCatalogEntry | null;
};
export type RuntimeModelDefaults = {
    defaults: {
        chat: RuntimeModelDefaultSlot;
        oneTime: RuntimeModelDefaultSlot;
        recurring: RuntimeModelDefaultSlot;
        memoryExtractor: RuntimeModelDefaultSlot;
        memoryDreaming: RuntimeModelDefaultSlot;
        memoryConsolidation: RuntimeModelDefaultSlot;
    };
};
export type RuntimeModelDefaultsPatchResult = {
    ok: true;
} | {
    ok: false;
    message: string;
};
export declare function readRuntimeModelDefaults(input: {
    runtimeHome: string;
    getDefaultModelConfig: RuntimeModelDefaultResolver;
}): RuntimeModelDefaults;
export declare function updateRuntimeModelDefaults(input: {
    runtimeHome: string;
    body: Record<string, unknown>;
    appId?: AppId;
    createdBy?: string;
    getConfiguredModelProviderIds?: () => Promise<ReadonlySet<string>>;
}): Promise<RuntimeModelDefaultsPatchResult>;
