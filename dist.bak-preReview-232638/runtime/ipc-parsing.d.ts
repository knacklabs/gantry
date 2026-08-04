import { MemoryIpcAction } from '@gantry/contracts';
import { PermissionApprovalRequest, type RichInteractionRequest, UserQuestionRequest } from '../domain/types.js';
import { type BrowserBackendAction } from '../shared/browser-backend-actions.js';
import { parseIpcMessageFiles } from './ipc-message-files.js';
import { parsePermissionCancellationIpcRequest, parseQuestionCancellationIpcRequest } from './ipc-parsing-permission-lifecycle.js';
export { parsePermissionCancellationIpcRequest, parseQuestionCancellationIpcRequest, };
export type ParsedPermissionIpcRequest = PermissionApprovalRequest & {
    classifierToolInput?: Record<string, unknown>;
    toolInputRedactedPaths?: string[];
    toolInputTruncatedPaths?: string[];
};
export interface ParsedIpcMessage {
    type: 'message';
    appId?: string;
    providerAccountId?: string;
    chatJid: string;
    text: string;
    sender?: string;
    threadId?: string;
    files?: ReturnType<typeof parseIpcMessageFiles>;
}
export interface ParsedMemoryIpcRequest {
    requestId: string;
    action: MemoryIpcAction;
    payload: Record<string, unknown>;
    responseKeyId?: string;
    deadlineAtMs?: number;
    allowedActions: readonly MemoryIpcAction[];
    context?: {
        threadId?: string;
        chatJid?: string;
        userId?: string;
        defaultScope?: 'user' | 'group';
        reviewerIsControlApprover?: boolean;
    };
}
export interface ParsedBrowserIpcRequest {
    requestId: string;
    action: BrowserBackendAction;
    payload: Record<string, unknown>;
    chatJid: string;
    threadId?: string;
    responseKeyId?: string;
    jobId?: string;
    runId?: string;
    appId?: string;
    agentId?: string;
    publicToolName?: string;
    timeoutMs?: number;
    deadlineAtMs?: number;
}
export declare function parseIpcMessage(raw: unknown, sourceAgentFolder: string): ParsedIpcMessage;
export declare function parseMemoryIpcRequest(raw: unknown, sourceAgentFolder: string): ParsedMemoryIpcRequest;
export declare function parsePermissionIpcRequest(raw: unknown, sourceAgentFolder: string): ParsedPermissionIpcRequest;
export declare function parseUserQuestionIpcRequest(raw: unknown, sourceAgentFolder: string): UserQuestionRequest;
export declare function parseRichInteractionIpcRequest(raw: unknown, sourceAgentFolder: string): RichInteractionRequest;
export declare function parseBrowserIpcRequest(raw: unknown, sourceAgentFolder: string): ParsedBrowserIpcRequest;
