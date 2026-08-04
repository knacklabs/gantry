import { MemoryIpcAction } from '@gantry/contracts';
import type { BrowserBackendAction } from '../../shared/browser-backend-actions.js';
export declare function writeIpcFile(dir: string, data: object): string;
export declare function hasValidIpcResponseSignature(raw: Record<string, unknown>, payload: Record<string, unknown>): boolean;
export declare function requestMemoryAction(action: MemoryIpcAction, payload: Record<string, unknown>): Promise<{
    ok: boolean;
    provider?: string;
    data?: unknown;
    error?: string;
}>;
export declare function requestBrowserAction(action: BrowserBackendAction, payload: Record<string, unknown>, options?: {
    timeoutMs?: number;
    publicToolName?: string;
}): Promise<{
    ok: boolean;
    data?: unknown;
    error?: string;
}>;
export interface TaskResponseEnvelope {
    taskId: string;
    ok: boolean;
    code?: string;
    message?: string;
    error?: string;
    details?: string[];
    data?: unknown;
    timestamp?: string;
}
export declare function waitForTaskResponse(taskId: string, timeoutMs?: number): Promise<TaskResponseEnvelope | null>;
