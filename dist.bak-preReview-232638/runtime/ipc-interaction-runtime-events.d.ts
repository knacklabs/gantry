import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type { PermissionApprovalRequest, UserQuestionRequest } from '../domain/types.js';
import type { IpcDeps } from './ipc-domain-types.js';
export declare function publishPermissionRuntimeEvent(deps: IpcDeps, request: PermissionApprovalRequest, input: {
    eventType: (typeof RUNTIME_EVENT_TYPES)[keyof typeof RUNTIME_EVENT_TYPES];
    payload: Record<string, unknown>;
}): Promise<void>;
export declare function publishPendingInteractionRuntimeEvent(deps: IpcDeps, request: PermissionApprovalRequest | UserQuestionRequest, kind: 'permission' | 'question', sourceAgentFolder: string): Promise<void>;
