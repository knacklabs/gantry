import { type GantryMemoryIpcAction } from '../shared/memory-ipc-actions.js';
interface IpcThreadBinding {
    appId?: string;
    agentId?: string;
    providerAccountId?: string;
    authThreadId?: string;
    payloadThreadId?: string | null;
    responseKeyId?: string;
}
interface IpcBrowserBinding extends IpcThreadBinding {
    chatJid: string;
}
interface IpcMemoryBinding extends IpcThreadBinding {
    chatJid?: string;
    userId?: string;
    defaultScope?: 'user' | 'group';
    reviewerIsControlApprover?: boolean;
    allowedActions: readonly GantryMemoryIpcAction[];
}
export declare function clearConsumedIpcRequestIds(input?: {
    durable?: boolean | 'consumed';
}): void;
export declare function validateIpcAuthRequest(raw: Record<string, unknown>, sourceAgentFolder: string, label: string, options?: {
    extendedAuthPurpose: 'unbounded-interaction' | 'cancellation-retention';
    extendedMaxAgeMs: number;
}): IpcThreadBinding;
export declare function validateInteractionIpcAuthRequest(raw: Record<string, unknown>, sourceAgentFolder: string, label: string): IpcThreadBinding;
export declare function validateBrowserIpcAuthRequest(raw: Record<string, unknown>, sourceAgentFolder: string, label: string): IpcBrowserBinding;
export declare function validateMemoryIpcAuthRequest(raw: Record<string, unknown>, sourceAgentFolder: string, label: string): IpcMemoryBinding;
export {};
