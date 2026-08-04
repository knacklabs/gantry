import type { MessageSendOptions, PermissionApprovalDecisionMode, ProgressUpdateOptions, UserQuestionRequest } from '../domain/types.js';
export declare const LIVE_STOP_CUSTOM_ID_PREFIX = "gantry:live_stop:";
export declare const SCHEDULER_RUN_NOW_CUSTOM_ID_PREFIX = "gantry:scheduler_run_now:";
export declare const PERMISSION_CUSTOM_ID_PREFIX = "gantry:perm:";
export declare const QUESTION_CUSTOM_ID_PREFIX = "gantry:q:";
export declare function discordActionComponents(options?: MessageSendOptions | ProgressUpdateOptions): unknown[] | undefined;
export declare function buttonRows(buttons: Array<{
    label: string;
    style: number;
    custom_id: string;
}>): unknown[];
export declare function questionComponents(request: UserQuestionRequest, questionIndex: number, providerAlias: string): unknown[];
export declare function permissionCustomId(providerAlias: string, mode: PermissionApprovalDecisionMode): string;
export declare function parsePermissionCustomId(customId: string): {
    providerAlias: string;
    mode: PermissionApprovalDecisionMode;
} | null;
export declare function questionCustomId(providerAlias: string, optionIndex: number): string;
export declare function questionDoneCustomId(providerAlias: string): string;
export declare function parseQuestionCustomId(customId: string): {
    providerAlias: string;
    optionIndex: number;
} | null;
