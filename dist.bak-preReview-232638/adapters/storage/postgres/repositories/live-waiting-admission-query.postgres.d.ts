import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export interface OldestWaitingLiveAdmission {
    conversationJid: string;
    threadId: string | null;
    waitingSince: string;
    ageSeconds: number;
}
export declare function getOldestWaitingLiveAdmission(db: CanonicalDb, input: {
    conversationJids: string[];
    now?: string;
}): Promise<OldestWaitingLiveAdmission | null>;
