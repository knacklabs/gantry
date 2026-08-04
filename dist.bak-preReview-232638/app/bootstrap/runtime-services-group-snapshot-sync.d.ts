import type { RuntimeApp } from './runtime-app.js';
type GroupSnapshotSyncDeps = {
    writeGroupsSnapshot: typeof import('../../runtime/agent-spawn.js').writeGroupsSnapshot;
    logger: {
        warn: (context: {
            err: unknown;
        }, message: string) => void;
    };
};
export declare function createGroupSnapshotSync(app: RuntimeApp, deps: GroupSnapshotSyncDeps): () => void;
export {};
