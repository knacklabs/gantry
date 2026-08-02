import type { SessionCommandDeps } from './session-commands.js';
export declare const COMPACTION_QUEUED_MESSAGE = "Compaction queued. You can keep messaging me; I'll use the compacted context when it's ready.";
export declare const COMPACTION_ALREADY_RUNNING_MESSAGE = "Compaction is already running or queued. You can keep messaging me.";
export declare function hasQueuedSessionCompaction(scopeKey: string): boolean;
export declare function queueSessionCompaction(groupName: string, deps: SessionCommandDeps, baseCursor?: string): Promise<'queued' | 'already_running'>;
