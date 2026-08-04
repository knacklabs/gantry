import type { AppSessionRecord } from '../schema/control-plane-records.postgres.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare function getControlSessionById(db: CanonicalDb, sessionId: string): Promise<AppSessionRecord | undefined>;
export declare function getControlSessionsByIds(db: CanonicalDb, sessionIds: readonly string[]): Promise<AppSessionRecord[]>;
export declare function getControlSessionByChatJid(db: CanonicalDb, chatJid: string): Promise<AppSessionRecord | undefined>;
export declare function getControlSessionsByChatJids(db: CanonicalDb, chatJids: readonly string[]): Promise<AppSessionRecord[]>;
