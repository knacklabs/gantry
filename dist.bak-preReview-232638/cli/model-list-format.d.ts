import { type ModelWorkload } from '../shared/model-catalog.js';
import { type FamilyOrderOverrides } from '../shared/model-families.js';
interface ModelListSettings {
    agent: {
        defaultModel: string;
        oneTimeJobDefaultModel: string;
        recurringJobDefaultModel: string;
    };
    memory: {
        llm: {
            models: {
                extractor: string;
                dreaming: string;
                consolidation: string;
            };
        };
    };
    modelFamilies: Record<string, string[]>;
}
export interface ModelStatusSettings extends ModelListSettings {
    agents: Record<string, {
        model?: string;
        oneTimeJobDefaultModel?: string;
        recurringJobDefaultModel?: string;
    }>;
    bindings: Record<string, {
        model?: string;
    }>;
}
export declare function chatAlias(settings: ModelListSettings): string;
export declare function effectiveJobAlias(settings: ModelListSettings, kind: 'oneTime' | 'recurring'): string;
export declare function providerForAlias(alias: string, workload: ModelWorkload, familyOrder?: FamilyOrderOverrides): string | undefined;
export declare function providerFromSettings(settings: ModelListSettings): string;
export declare function configuredProviderIdsForCli(runtimeHome: string): Promise<ReadonlySet<string> | undefined>;
export declare function memoryResetProviderFromSettings(runtimeHome: string, settings: ModelListSettings): Promise<string>;
export declare function memoryProviderFromSettings(settings: ModelListSettings): string;
export declare function resolveSlot(alias: string, workload: ModelWorkload): string;
export declare function formatModelStatus(settings: ModelStatusSettings): string;
export declare function formatModelList(settings: ModelListSettings, providerId: string | undefined, availability?: {
    configuredProviders?: Set<string>;
    familyOrder?: FamilyOrderOverrides;
}): string;
export declare function fetchConfiguredProviders(runtimeHome: string): Promise<Set<string> | undefined>;
export declare function familyOrderFromSettings(settings: ModelListSettings): FamilyOrderOverrides | undefined;
export {};
