import type { MaterializedMcpCapability } from './mcp-server-service.js';
type CloseableMcpClient = {
    close(): Promise<unknown> | unknown;
};
export declare function readCachedMcpClient(capability: MaterializedMcpCapability): CloseableMcpClient | null;
export declare function cacheMcpClient(capability: MaterializedMcpCapability, client: CloseableMcpClient): void;
export declare function scheduleMcpClientIdleClose(capability: MaterializedMcpCapability): void;
export declare function retainMcpClient(capability: MaterializedMcpCapability): void;
export declare function releaseMcpClient(capability: MaterializedMcpCapability): void;
export declare function closeCachedMcpClient(capability: MaterializedMcpCapability): Promise<void>;
export {};
