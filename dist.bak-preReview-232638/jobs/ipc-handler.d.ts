import { IpcDeps } from '../runtime/ipc-domain-types.js';
import { TaskIpcData } from './ipc-types.js';
import type { PermissionApprovalDecision, PermissionApprovalRequest } from '../domain/types.js';
export declare function requestDurableTaskPermissionApproval(request: PermissionApprovalRequest, prompt: (request: PermissionApprovalRequest) => Promise<PermissionApprovalDecision>): Promise<PermissionApprovalDecision>;
export type { TaskIpcData } from './ipc-types.js';
export declare function processTaskIpc(data: TaskIpcData, sourceAgentFolder: string, deps: IpcDeps, ipcBaseDir?: string): Promise<void>;
