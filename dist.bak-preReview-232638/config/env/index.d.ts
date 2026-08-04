export declare const CONFIG_ENV_KEYS: readonly ["GANTRY_HOME", "SECRET_ENCRYPTION_KEY", "TZ", "GANTRY_IPC_AUTH_SECRET", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "LOG_LEVEL", "GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS", "GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS", "PERMISSION_APPROVAL_TIMEOUT_MS", "GANTRY_PERMISSION_TIMEOUT_MS", "TELEGRAM_BOT_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "DISCORD_BOT_TOKEN", "DISCORD_APPLICATION_ID"];
export declare const envConfig: Record<string, string>;
export declare function envValue(key: (typeof CONFIG_ENV_KEYS)[number]): string;
export declare function runtimeEnvValue(key: (typeof CONFIG_ENV_KEYS)[number]): string;
export declare function envValueDynamic(key: string): string;
export declare function runtimeEnvValueDynamic(key: string): string;
