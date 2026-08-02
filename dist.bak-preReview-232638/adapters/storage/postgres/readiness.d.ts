import type { StorageCapabilities } from './storage-service.js';
export interface PostgresStorageReadinessFailure {
    summary: string;
    details: string[];
}
export declare function evaluatePostgresStorageCapabilities(capabilities: StorageCapabilities): PostgresStorageReadinessFailure | null;
