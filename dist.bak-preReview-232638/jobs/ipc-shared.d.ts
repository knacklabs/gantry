import { toTrimmedString } from '../shared/object.js';
import type { CoreTaskLifecycleResult } from '../application/core-tools/task-lifecycle.js';
import type { TaskContext } from './ipc-types.js';
export { toTrimmedString };
export declare function taskIpcResponsePath(sourceAgentFolder: string, taskId: string): string;
export declare function writeTaskIpcResponse(sourceAgentFolder: string, taskId: string | undefined, payload: {
    ok: boolean;
    code?: string;
    message?: string;
    error?: string;
    details?: string[];
    data?: unknown;
}, authThreadId?: string, responseKeyId?: string): void;
export declare function createTaskResponder(sourceAgentFolder: string, taskIdRaw: unknown, authThreadId?: string, responseKeyId?: string): {
    accept: (message: string, code?: string, details?: string[]) => void;
    acceptData: (message: string, data: unknown, code?: string, details?: string[]) => void;
    reject: (error: string, code?: string, details?: string[]) => void;
};
export declare function respondTaskLifecycleResult(context: TaskContext, result: CoreTaskLifecycleResult): void;
export declare function restartServiceForRuntimeHome(runtimeHome: string): {
    ok: boolean;
    message: string;
};
