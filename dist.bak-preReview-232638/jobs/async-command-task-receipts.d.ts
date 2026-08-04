import type { AsyncTaskRecord } from '../domain/ports/async-tasks.js';
export declare function cancelledReceipt(task: AsyncTaskRecord, childCancelledCount?: number): {
    completed: string;
    used: string;
    changed: string;
    delegated: "no";
    needsAttention: string;
    subtasks?: undefined;
} | {
    completed: string;
    used: string;
    changed: string;
    delegated: "yes";
    subtasks: string;
    needsAttention: string;
};
export declare function failedReceipt(task: AsyncTaskRecord, completed: string): {
    completed: string;
    used: string;
    changed: string;
    delegated: "no";
    needsAttention: string;
    subtasks?: undefined;
} | {
    completed: string;
    used: string;
    changed: string;
    delegated: "yes";
    subtasks: string;
    needsAttention: string;
};
