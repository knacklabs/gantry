export interface ChatAllowlistEntry {
    allow: '*' | string[];
    mode: 'trigger' | 'drop';
}
export interface SenderAllowlistConfig {
    default: ChatAllowlistEntry;
    agents: Record<string, ChatAllowlistEntry>;
    logDenied: boolean;
}
export declare function createDefaultSenderAllowlist(): SenderAllowlistConfig;
export declare function parseSenderAllowlistConfig(raw: unknown, pathPrefix: string): SenderAllowlistConfig;
export declare function renderSenderAllowlistYaml(lines: string[], indent: string, quoteYamlKey: (key: string) => string, config: SenderAllowlistConfig): void;
