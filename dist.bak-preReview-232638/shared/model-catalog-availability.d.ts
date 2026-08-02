import { type FamilyOrderOverrides, type FamilyResolutionDescription, type ModelFamily } from './model-families.js';
export declare function providerLabel(providerId: string | undefined): string;
export declare function availabilityBadgeForProvider(providerId: string, configuredProviders: Set<string> | undefined): string | undefined;
export declare function describeFamilyAvailability(family: ModelFamily, configuredProviders: Set<string> | undefined, order?: FamilyOrderOverrides): FamilyResolutionDescription;
export declare function familyAvailabilityBadge(description: FamilyResolutionDescription, configuredProviders: Set<string> | undefined): string | undefined;
