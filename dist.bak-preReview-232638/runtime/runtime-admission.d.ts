import type { QueuedTask, TaskAdmissionClass } from './group-queue-types.js';
export declare const DEFAULT_TASK_ADMISSION_CLASS: TaskAdmissionClass;
export declare function enqueueByAdmissionClass<T extends {
    admissionClass: TaskAdmissionClass;
}>(pending: T[], task: T): void;
export declare function createQueuedTask(groupJid: string, id: string, fn: () => Promise<void>, admissionClass?: TaskAdmissionClass): QueuedTask;
export declare function dequeueTaskGroupByAdmissionClass(waitingTaskGroups: string[], groups: ReadonlyMap<string, {
    active: boolean;
    pendingTasks: readonly QueuedTask[];
}>): string | null;
