import type { GroupProcessOptions, GroupProcessingDeps } from './group-processing-types.js';
export declare function createGroupProcessor(deps: GroupProcessingDeps): {
    processGroupMessages: (queueJid: string, options?: GroupProcessOptions) => Promise<boolean>;
};
