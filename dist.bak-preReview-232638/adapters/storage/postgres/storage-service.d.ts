import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as pgSchema from './schema/schema.js';
export declare const postgresMigrationsFolder: string;
export declare const RUNTIME_MIGRATION_LOCK_NAMESPACE = 1340193180;
export declare const RUNTIME_MIGRATION_LOCK_KEY = 2;
export declare const GENERATED_ALWAYS_IDENTITY_PRIMARY_KEYS: readonly [{
    readonly tableName: "runtime_events";
    readonly columnName: "event_id";
}, {
    readonly tableName: "message_parts";
    readonly columnName: "id";
}, {
    readonly tableName: "memory_recall_events";
    readonly columnName: "id";
}];
export interface StorageCapabilities {
    lexicalSearch: boolean;
    vectorSearch: boolean;
    vectorReason?: string;
    textSearch?: boolean;
    textSearchReason?: string;
    jobQueue?: boolean;
    jobQueueReason?: string;
    runtimeEvents?: boolean;
    runtimeEventsReason?: string;
    eventBusOutbox?: boolean;
    eventBusOutboxReason?: string;
}
export interface StorageService {
    migrate(): Promise<void>;
    assertMigrationsCurrent(): Promise<void>;
    healthCheck(): Promise<StorageCapabilities>;
    close(): Promise<void>;
}
export interface ResolvedStorageConfig {
    postgresUrl: string | null;
    postgresUrlEnv: string;
    postgresSchema: string;
    postgresPlaintextHostAllowlist?: readonly string[];
}
export interface PostgresConnectionSecurityOptions {
    plaintextHostAllowlist?: readonly string[];
}
export declare function quotePostgresIdentifier(identifier: string): string;
export declare function resolveRuntimePostgresPoolMax(env?: NodeJS.ProcessEnv): number;
export declare function resolvePostgresPoolConfig(url: string, schema: string, security?: PostgresConnectionSecurityOptions): PoolConfig;
export declare class PostgresStorageService implements StorageService {
    private readonly url;
    private readonly schemaName;
    private readonly security;
    readonly pool: Pool;
    readonly db: NodePgDatabase<typeof pgSchema>;
    constructor(url: string, schemaName: string, security?: PostgresConnectionSecurityOptions);
    migrate(): Promise<void>;
    assertMigrationsCurrent(): Promise<void>;
    private assertDefaultRuntimeDataSeeded;
    /**
     * Run the drizzle migrator under the shared cross-instance advisory lock so
     * concurrent migrators (entrypoint passes and runtime boots, in any mix)
     * serialize: the lock holder migrates, the rest block then find nothing
     * pending. The lock is session-scoped — it is released automatically if the
     * holder crashes mid-migration.
     */
    private runSchemaMigrationsUnderLock;
    private ensurePgcryptoExtension;
    private migratePgBoss;
    healthCheck(): Promise<StorageCapabilities>;
    close(): Promise<void>;
}
export declare function createStorageService(config: ResolvedStorageConfig): PostgresStorageService;
