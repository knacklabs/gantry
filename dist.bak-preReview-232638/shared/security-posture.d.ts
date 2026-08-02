export interface RuntimeSecurityEnv {
    NODE_ENV?: string;
    GANTRY_RUNTIME_ENV?: string;
    GANTRY_SECURITY_POSTURE?: string;
    GANTRY_CONTROL_HOST?: string;
    GANTRY_CONTROL_PORT?: string;
    GANTRY_CONTROL_API_KEYS_JSON?: string;
    GANTRY_IPC_AUTH_SECRET?: string;
    REMOTE_CONTROL_AUTO_ACCEPT?: string;
    SECRET_ENCRYPTION_KEY?: string;
    SECRET_ENCRYPTION_KEYRING_JSON?: string;
}
export interface RuntimeSecurityPosture {
    production: boolean;
    remoteControl: boolean;
    requiresProductionSecrets: boolean;
    requiresEnforcingSandbox: boolean;
}
export declare function isLocalControlHost(host: string | undefined): boolean;
export declare function resolveRuntimeSecurityPosture(env: RuntimeSecurityEnv): RuntimeSecurityPosture;
export declare function validateProductionSecurityGate(input: {
    env: RuntimeSecurityEnv;
    sandboxProvider?: 'direct' | 'sandbox_runtime';
}): string[];
export declare function hasValidEncryptionSecret(env: RuntimeSecurityEnv): boolean;
