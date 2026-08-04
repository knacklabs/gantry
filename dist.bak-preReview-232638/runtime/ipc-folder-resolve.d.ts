import type { ConversationRoute as RuntimeGroupRecord } from '../domain/types.js';
export declare function resolveIpcFoldersFromGroups(groupRegistry: Record<string, RuntimeGroupRecord>): string[];
export declare function resolveIpcTargetJidForSourceGroup(groupRegistry: Record<string, RuntimeGroupRecord>, sourceAgentFolder: string): string | undefined;
