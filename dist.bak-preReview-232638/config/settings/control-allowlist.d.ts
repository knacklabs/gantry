export interface SenderControlAllowlistConfig {
    default: string[];
    agents: Record<string, string[]>;
}
export declare const DEFAULT_CONTROL_ALLOWLIST: SenderControlAllowlistConfig;
export declare function createDefaultControlAllowlist(): SenderControlAllowlistConfig;
export declare function parseSenderControlAllowlistConfig(raw: unknown, pathPrefix: string): SenderControlAllowlistConfig;
export declare function renderControlAllowlistYaml(lines: string[], indent: string, quoteYamlKey: (key: string) => string, config: SenderControlAllowlistConfig): void;
export declare function addControlSenderForAgent(channel: {
    controlAllowlist: SenderControlAllowlistConfig;
}, folder: string, sender: string): boolean;
