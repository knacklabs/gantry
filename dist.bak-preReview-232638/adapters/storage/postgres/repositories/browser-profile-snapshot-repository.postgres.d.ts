import type { BrowserProfileSnapshot, BrowserProfileSnapshotRepository, UpsertBrowserProfileSnapshotInput, UpsertBrowserProfileSnapshotResult } from '../../../../domain/ports/browser-profile-snapshot.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresBrowserProfileSnapshotRepository implements BrowserProfileSnapshotRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    getBrowserProfileSnapshot(profileName: string): Promise<BrowserProfileSnapshot | null>;
    upsertBrowserProfileSnapshot(input: UpsertBrowserProfileSnapshotInput): Promise<UpsertBrowserProfileSnapshotResult>;
}
