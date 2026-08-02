import type { ProgressUpdateOptions } from '../domain/types.js';
export type FinalProgressState = 'completed' | 'failed' | 'delivery_incomplete' | 'stopped';
export declare function buildReplaceOnlyProgressOptions(threadId?: string, generation?: number): ProgressUpdateOptions;
export declare function sendFinalProgressUpdate(args: {
    enabled: boolean;
    state: FinalProgressState;
    options: ProgressUpdateOptions;
    send: (text: string, options?: ProgressUpdateOptions) => Promise<void>;
    onError?: (err: unknown) => void;
}): Promise<void>;
