import { NEUTRAL_CA_TRUST_ENV_KEYS } from '../../../../shared/neutral-ca-trust-env.js';
export { NEUTRAL_CA_TRUST_ENV_KEYS };
export declare function applyBashTrustEnv(toolName: string, input: Record<string, unknown>, toolNetworkEnv: Record<string, string | undefined>): Record<string, unknown>;
export declare function applyBashTrustEnvWithProvenance(toolName: string, input: Record<string, unknown>, toolNetworkEnv: Record<string, string | undefined>): {
    toolInput: Record<string, unknown>;
    hostInjectedCommandPrefix?: string;
};
