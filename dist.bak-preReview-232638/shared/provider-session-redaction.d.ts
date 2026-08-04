export declare const PROVIDER_SESSION_FIELD_NAME_LIST: readonly ["sessionId", "newSessionId", "providerSessionId", "externalSessionId", "latestProviderSessionId", "session_id"];
export declare const PROVIDER_SESSION_HANDLE_START_LIST: readonly ["claude-session-", "provider-session:"];
export declare function redactProviderSessionHandlesInText(value: string): string;
