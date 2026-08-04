import type { RuntimeProviderAccountSettings, RuntimeProviderSettings } from './runtime-settings-types.js';
export declare function parseProviderAccounts(raw: unknown, providers: Record<string, RuntimeProviderSettings>, agents: Record<string, {
    name: string;
}>): Record<string, RuntimeProviderAccountSettings>;
