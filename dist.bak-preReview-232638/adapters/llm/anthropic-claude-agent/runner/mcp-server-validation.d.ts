import type { McpServerConfig } from '../agent-capabilities.js';
export declare function readExternalMcpServers(): Record<string, McpServerConfig>;
export declare function setExternalMcpServerEgressEnv(toolNetworkEnv: Record<string, string>): void;
export declare function assertRequiredMcpServerReady(message: unknown): void;
