import type { MemoryIpcResponse } from '@gantry/contracts';
interface BrainIpcRequest {
    requestId: string;
    payload: Record<string, unknown>;
    deadlineAtMs?: number;
}
export declare function processBrainSearchRequest(request: BrainIpcRequest): Promise<MemoryIpcResponse>;
export declare function processBrainQueryRequest(request: BrainIpcRequest): Promise<MemoryIpcResponse>;
export declare function processBrainWriteRequest(request: BrainIpcRequest, sourceAgentFolder: string): Promise<MemoryIpcResponse>;
export {};
