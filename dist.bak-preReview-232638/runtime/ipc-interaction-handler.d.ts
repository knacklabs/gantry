import { PermissionApprovalDecision, PermissionApprovalRequest, UserQuestionRequest, UserQuestionResponse } from '../domain/types.js';
import { IpcDeps } from './ipc-domain-types.js';
export declare function processPermissionIpcRequest(request: PermissionApprovalRequest, deps: Pick<IpcDeps, 'requestPermissionApproval'>): Promise<PermissionApprovalDecision>;
export declare function processUserQuestionIpcRequest(request: UserQuestionRequest, deps: Pick<IpcDeps, 'requestUserAnswer'>): Promise<UserQuestionResponse>;
export declare function writePermissionIpcResponse(ipcBaseDir: string, sourceAgentFolder: string, decision: PermissionApprovalDecision & {
    requestId: string;
    responseNonce?: string;
}, privateKeyPem?: string): void;
export declare function writeUserQuestionIpcResponse(ipcBaseDir: string, sourceAgentFolder: string, response: UserQuestionResponse, privateKeyPem?: string): void;
