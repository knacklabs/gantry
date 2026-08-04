import { AvailableGroup } from './agent-spawn-types.js';
export declare function clearSnapshotWriteCacheForTests(): void;
export declare function writeGroupsSnapshot(workspaceFolder: string, groups: AvailableGroup[], _registeredJids: Set<string>): Promise<void>;
