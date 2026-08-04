import type { RuntimeProviderId } from './provider-utils.js';
import type { ChatAllowlistEntry } from '../config/settings/sender-allowlist.js';
export interface GroupAddOptions {
    selector?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    sendTestMessage: boolean;
}
export interface GroupRemoveOptions {
    selector?: string;
    assumeYes: boolean;
}
export interface GroupTriggerOptions {
    selector?: string;
    trigger?: string;
    disable: boolean;
}
export interface GroupPolicyOptions {
    selector?: string;
    allow?: '*' | string[];
    mode?: ChatAllowlistEntry['mode'];
    clear: boolean;
}
export interface GroupPolicyDefaultOptions {
    channel?: RuntimeProviderId;
    allow?: '*' | string[];
    mode?: ChatAllowlistEntry['mode'];
}
export interface GroupPolicyShowOptions {
    channel?: RuntimeProviderId;
}
export declare function parseGroupAddArgs(args: string[]): GroupAddOptions | {
    error: string;
};
export declare function parseGroupRemoveArgs(args: string[]): GroupRemoveOptions | {
    error: string;
};
export declare function parseGroupTriggerArgs(args: string[]): GroupTriggerOptions | {
    error: string;
};
export declare function parseGroupPolicyArgs(args: string[]): GroupPolicyOptions | {
    error: string;
};
export declare function parseGroupPolicyDefaultArgs(args: string[]): GroupPolicyDefaultOptions | {
    error: string;
};
export declare function parseGroupPolicyShowArgs(args: string[]): GroupPolicyShowOptions | {
    error: string;
};
