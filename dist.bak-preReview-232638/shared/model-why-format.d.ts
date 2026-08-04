import { type FamilyOrderOverrides } from './model-families.js';
export declare function formatModelWhy(input: {
    value: string;
    configuredProviders?: Set<string>;
    familyOrder?: FamilyOrderOverrides;
}): string;
export declare function resolvedProviderIdForWhy(input: {
    value: string;
    configuredProviders?: Set<string>;
    familyOrder?: FamilyOrderOverrides;
}): string | undefined;
