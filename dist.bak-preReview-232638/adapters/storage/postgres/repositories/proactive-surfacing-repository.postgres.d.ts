import type { ProactiveSurfacingOptIn, ProactiveSurfacingSubject } from '../../../../domain/ports/proactive-surfacing-consent.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresProactiveSurfacingRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    getBySubject(subject: ProactiveSurfacingSubject): Promise<ProactiveSurfacingOptIn | null>;
    setEnabled(input: {
        subject: ProactiveSurfacingSubject;
        id: string;
        conversationJid?: string | null;
        actorId?: string | null;
        nowIso: string;
    }): Promise<ProactiveSurfacingOptIn>;
    setOptedOut(input: {
        subject: ProactiveSurfacingSubject;
        actorId?: string | null;
        nowIso: string;
    }): Promise<ProactiveSurfacingOptIn | null>;
}
