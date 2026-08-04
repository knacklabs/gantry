import { type FamilyOrderOverrides } from '../shared/model-families.js';
export type ConfiguredModelProvidersLookup = (appId: string) => Promise<Set<string>>;
export declare function rewriteModelFamilyAliasForApp(input: {
    alias: string;
    appId: string;
    listConfiguredProviders: ConfiguredModelProvidersLookup;
    familyOrder?: FamilyOrderOverrides;
}): Promise<string>;
export declare function resolveModelFamilyCandidatesForApp(input: {
    alias: string;
    appId: string;
    listConfiguredProviders: ConfiguredModelProvidersLookup;
    familyOrder?: FamilyOrderOverrides;
}): Promise<string[]>;
