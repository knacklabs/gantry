export type SemanticCapabilityRisk = 'read' | 'write' | 'admin';
export type SemanticCapabilityCredentialSource = 'configured_access' | 'skill_secret' | 'local_cli' | 'none';
export type SemanticCapabilityImplementationKind = 'tool_rule' | 'mcp_tool' | 'mcp_pattern' | 'adapter' | 'local_cli';
export interface SemanticCapabilityImplementationBinding {
    kind: SemanticCapabilityImplementationKind;
    rule?: string;
    mcpTool?: string;
    mcpServer?: string;
    mcpToolPatterns?: string[];
    adapterRef?: string;
    executablePath?: string;
    executableVersion?: string;
    executableHash?: string;
    commandTemplates?: string[];
    authPreflightCommand?: string;
    deniedEnvPatterns?: string[];
}
export interface SemanticCapabilityDefinition {
    capabilityId: string;
    version?: string;
    displayName: string;
    category: string;
    risk: SemanticCapabilityRisk;
    accountLabel?: string;
    can: string;
    cannot: string;
    credentialSource: SemanticCapabilityCredentialSource;
    implementationBindings: SemanticCapabilityImplementationBinding[];
    preflight?: {
        kind: 'none' | 'command' | 'broker';
        command?: string;
        status?: 'unknown' | 'healthy' | 'expired' | 'missing';
        message?: string;
    };
    protectedPaths?: string[];
    networkHosts?: string[];
    redactionPolicy?: {
        fields?: string[];
        env?: string[];
        commandParts?: string[];
    };
    sandboxProfile?: {
        network?: 'none' | 'required';
        filesystem?: 'read_only' | 'workspace_write' | 'credential_read';
    };
    source?: unknown;
}
export declare const DEFAULT_LOCAL_CLI_DENIED_ENV_PATTERNS: readonly ["*TOKEN*", "*SECRET*", "*PASSWORD*", "*API_KEY*", "*CREDENTIAL*", "*CONFIG*", "*PROXY*", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "PIP_CERT", "AWS_CA_BUNDLE", "CARGO_HTTP_CAINFO", "DENO_CERT"];
export declare function semanticCapabilityInputSchema(capability: SemanticCapabilityDefinition): {
    format: string;
    schema: SemanticCapabilityDefinition;
};
export declare function parseSemanticCapabilityDefinitionsRecord(raw: unknown): Record<string, SemanticCapabilityDefinition> | undefined;
export declare function semanticCapabilityFromToolCatalogItem(input: {
    name?: string;
    inputSchema?: unknown;
}): SemanticCapabilityDefinition | undefined;
export declare function semanticCapabilityRuntimeRules(capability: SemanticCapabilityDefinition): string[];
export declare function projectToolCatalogItemToRuntimeRules(input: {
    name: string;
    inputSchema?: unknown;
}): string[];
export declare function expandSemanticCapabilityPermissionRules(input: {
    rules: readonly string[];
    definitions?: Record<string, SemanticCapabilityDefinition>;
}): string[];
export declare function validateSemanticCapabilityDefinition(capability: SemanticCapabilityDefinition): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
export declare function buildLocalCliSemanticCapability(input: {
    capabilityId: string;
    displayName: string;
    category: string;
    risk: SemanticCapabilityRisk;
    accountLabel?: string;
    can: string;
    cannot: string;
    executablePath: string;
    executableVersion?: string;
    executableHash?: string;
    commandTemplates: string[];
    authPreflightCommand?: string;
    protectedPaths?: string[];
    networkHosts?: string[];
    deniedEnvPatterns?: string[];
}): SemanticCapabilityDefinition;
export declare function capabilityDisplayNameForRule(rule: string): string | undefined;
export declare function skillActionCapabilityDisplayName(capabilityId: string): string | undefined;
export declare function mcpPatternBindingRuntimeRules(binding: SemanticCapabilityImplementationBinding): string[];
