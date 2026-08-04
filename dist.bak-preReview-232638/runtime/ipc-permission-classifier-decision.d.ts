import type { PermissionApprovalDecision } from '../domain/types.js';
import type { IpcDeps } from './ipc-domain-types.js';
import type { ParsedPermissionIpcRequest } from './ipc-parsing.js';
export declare function resolvePermissionIpcDecision(input: {
    request: ParsedPermissionIpcRequest;
    sourceAgentFolder: string;
    deps: IpcDeps;
}): Promise<PermissionApprovalDecision>;
