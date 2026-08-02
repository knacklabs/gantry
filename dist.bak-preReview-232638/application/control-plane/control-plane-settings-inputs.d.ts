import type { ControlPlaneMemoryStatus, ControlPlaneProviderInput } from './control-plane-read-model.js';
/**
 * Minimal structural view of runtime settings needed to derive control-plane
 * provider/memory inputs. Both the redacted Control API settings and the full
 * RuntimeSettings satisfy this, so every surface shares one derivation.
 */
export interface ControlPlaneSettingsInputView {
    providers?: Record<string, {
        enabled?: boolean;
    } | undefined>;
    providerAccounts?: Record<string, {
        provider: string;
    }>;
}
export declare function controlPlaneProviderInputs(settings: ControlPlaneSettingsInputView): ControlPlaneProviderInput[];
export declare function controlPlaneMemoryStatus(enabled: boolean): ControlPlaneMemoryStatus;
export declare function controlPlaneJobStatus(status: string | undefined): 'ready' | 'needs_action' | 'blocked';
