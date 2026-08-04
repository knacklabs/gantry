import type { GroupProcessingDeps } from '../../runtime/group-processing-types.js';
type ChannelRuntime = GroupProcessingDeps['channelRuntime'];
export declare function createMutableChannelRuntime(): {
    proxy: ChannelRuntime;
    set: (runtime: ChannelRuntime) => void;
};
export {};
