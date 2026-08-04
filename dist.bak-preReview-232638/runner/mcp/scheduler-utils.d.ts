export declare const SCHEDULER_TARGET_SHORTCUTS: readonly ["here", "this_thread", "this_topic", "me_dm"];
export type SchedulerTargetShortcut = (typeof SCHEDULER_TARGET_SHORTCUTS)[number];
export declare function parseSchedulerTargetShortcut(value: unknown): SchedulerTargetShortcut | undefined;
export declare function resolveSchedulerShortcut(shortcut: SchedulerTargetShortcut): {
    threadId: string | null;
    error?: string;
};
export declare function routeLabelForShortcut(shortcut: SchedulerTargetShortcut): string;
