import type { ProgressUpdateOptions } from '../domain/types.js';
import type { GroupProcessingDeps } from './group-processing-types.js';
type RuntimeLogger = {
    warn(input: unknown, message: string): void;
};
export declare function createProgressChannelSender(input: {
    channelRuntime: GroupProcessingDeps['channelRuntime'];
    chatJid: string;
    groupName: string;
    finalizingGenerations: Set<number>;
    log: RuntimeLogger;
}): (text: string, options?: ProgressUpdateOptions) => Promise<void>;
export {};
