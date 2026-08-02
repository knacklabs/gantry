import { type ModelResolution, type ModelRouteId, type ModelWorkload } from './model-catalog.js';
export interface ModelFamily {
    alias: string;
    displayName: string;
    members: readonly string[];
}
export declare const MODEL_FAMILIES: readonly ModelFamily[];
export declare function listModelFamilies(): readonly ModelFamily[];
export type FamilyOrderOverrides = Readonly<Record<string, readonly string[]>>;
export declare const CHEAPEST_ORDER_TOKEN = "cheapest";
export declare function effectiveFamilyMembers(family: ModelFamily, order?: FamilyOrderOverrides): readonly string[];
export declare function isModelFamilyAlias(value: string | null | undefined): boolean;
export declare function getModelFamily(value: string | null | undefined): ModelFamily | undefined;
export declare function providerIdForFamilyMember(member: string): ModelRouteId | undefined;
export interface ModelFamilyResolution {
    alias: string;
}
export declare function resolveModelFamilyAlias(alias: string | null | undefined, deps: {
    isProviderConfigured: (providerId: string) => boolean;
    order?: FamilyOrderOverrides;
}): ModelFamilyResolution | null;
export declare function resolveModelFamilyCandidates(alias: string | null | undefined, deps: {
    isProviderConfigured: (providerId: string) => boolean;
    order?: FamilyOrderOverrides;
}): string[];
export interface FamilyMemberAvailability {
    member: string;
    providerId: string | undefined;
    providerLabel: string;
    configured: boolean;
}
export interface FamilyResolutionDescription {
    family: ModelFamily;
    members: readonly FamilyMemberAvailability[];
    selectedMember: string;
    selectedProviderId: string | undefined;
    selectedProviderLabel: string;
    selectedConfigured: boolean;
}
export declare function describeFamilyResolution(family: ModelFamily, deps: {
    isProviderConfigured: (providerId: string) => boolean;
    order?: FamilyOrderOverrides;
    providerLabel: (providerId: string | undefined) => string;
}): FamilyResolutionDescription;
export declare function resolveModelSelectionForWorkloadWithFamilies(value: string | null | undefined, workload: ModelWorkload, order?: FamilyOrderOverrides): ModelResolution;
