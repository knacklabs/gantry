import type { ReleasedStaleJobLease } from '../../../../domain/repositories/ops-repo.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
/**
 * Stale recovery only: releases job leases whose expiry has lapsed. Live
 * leases are never released here — startup recovery must not interrupt runs
 * that another worker still holds.
 */
export declare function releaseStaleCanonicalJobLeases(db: CanonicalDb, nowIso: string): Promise<ReleasedStaleJobLease[]>;
