export type ConfigSourceLane = 'runtime-secret' | 'non-secret-setting' | 'agent-credential' | 'broker-safe-injection';
export interface ClassifiedConfigKey {
    key: string;
    lane: ConfigSourceLane;
    destination: string;
    message: string;
}
export declare const AGENT_CREDENTIAL_ENV_KEYS: readonly string[];
export interface RuntimeEnvPolicyViolation {
    key: string;
    lane: ConfigSourceLane;
    message: string;
    destination: string;
}
export interface RuntimeEnvPolicyResult {
    ok: boolean;
    violations: RuntimeEnvPolicyViolation[];
}
export declare function classifyConfigKey(key: string): ClassifiedConfigKey | undefined;
export declare function validateRuntimeEnvPolicy(env: Partial<Record<string, string | undefined>>, source?: string): RuntimeEnvPolicyResult;
export declare function validateRuntimeHomeEnvPolicy(runtimeHome: string): RuntimeEnvPolicyResult;
