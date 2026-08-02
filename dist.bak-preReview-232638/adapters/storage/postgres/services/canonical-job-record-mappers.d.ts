import type { JobEvent, JobRun } from '../../../../domain/repositories/domain-types.js';
import type { CanonicalJobEventRecord, CanonicalRunRecord } from '../repositories/canonical-job-repository.postgres.js';
export declare function mapCanonicalRunRecord(row: CanonicalRunRecord): JobRun;
export declare function mapCanonicalJobEventRecord(row: CanonicalJobEventRecord, index: number, fallbackJobId?: string): JobEvent;
