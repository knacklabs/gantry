import { MemoryIpcAction, MemoryIpcRequest, MemoryIpcResponse } from '@gantry/contracts';
export { parseOptionalNumber, parseOptionalString, } from './memory-ipc-parsing.js';
import { SaveMemoryInput, SaveProcedureInput } from './memory-types.js';
interface TrustedMemoryContext {
    threadId?: string;
    chatJid?: string;
    userId?: string;
    defaultScope?: 'user' | 'group';
    reviewerIsControlApprover?: boolean;
}
type TrustedMemoryRequest = Omit<MemoryIpcRequest, 'context'> & {
    context?: TrustedMemoryContext;
    allowedActions?: readonly MemoryIpcAction[];
    deadlineAtMs?: number;
};
export declare function resolveTrustedMemorySubject(sourceAgentFolder: string, context: TrustedMemoryContext | undefined, scope?: SaveMemoryInput['scope'] | SaveProcedureInput['scope']): import("./memory-types.js").NormalizedMemorySubject;
export declare function processMemoryRequest(request: TrustedMemoryRequest, sourceAgentFolder: string): Promise<MemoryIpcResponse>;
export declare function writeMemoryResponse(workspaceFolder: string, requestId: string, response: MemoryIpcResponse, privateKeyPem?: string): void;
