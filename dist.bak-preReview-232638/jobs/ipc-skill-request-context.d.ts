import type { AgentId } from '../domain/agent/agent.js';
import type { TaskHandler } from './ipc-types.js';
export declare function resolveTaskAgentId(data: Parameters<TaskHandler>[0]['data'], sourceAgentFolder: string): AgentId;
export declare function validateSameChannelApprovalTarget(input: {
    data: Parameters<TaskHandler>[0]['data'];
    sourceAgentFolderJids: string[];
    requestKind: string;
    reject: (error: string, code?: string, details?: string[]) => void;
}): string | null;
