import path from 'path';
import { fileURLToPath } from 'url';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePostgres } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { PgBoss } from 'pg-boss';
import { Pool } from 'pg';
import { isLocalPostgresHost, parsePostgresConnectionUrl } from './url.js';
import * as pgSchema from './schema/schema.js';
import { DEFAULT_AGENT_ID, DEFAULT_AGENT_CONFIG_VERSION_ID, DEFAULT_APP_ID, DEFAULT_LLM_PROFILE_ID, DEFAULT_PERMISSION_POLICY_ID, DEFAULT_PERMISSION_RULE_ID, DEFAULT_SANDBOX_PROFILE_ID, DEFAULT_SKILL_CATALOG, DEFAULT_TOOL_CATALOG, seedDefaultRuntimeData, } from './seeds.js';
const storageDir = path.dirname(fileURLToPath(import.meta.url));
export const postgresMigrationsFolder = path.join(storageDir, 'schema', 'migrations');
const PGCRYPTO_EXTENSION_LOCK_NAMESPACE = 1_340_193_180;
const PGCRYPTO_EXTENSION_LOCK_KEY = 1;
const DEFAULT_RUNTIME_POSTGRES_POOL_MAX = 20;
// Cross-instance "run gantry migrations" lock. One identity serializes every
// explicit migrator using PostgresStorageService.migrate().
export const RUNTIME_MIGRATION_LOCK_NAMESPACE = 1_340_193_180;
export const RUNTIME_MIGRATION_LOCK_KEY = 2;
export const GENERATED_ALWAYS_IDENTITY_PRIMARY_KEYS = [
    { tableName: 'runtime_events', columnName: 'event_id' },
    { tableName: 'message_parts', columnName: 'id' },
    { tableName: 'memory_recall_events', columnName: 'id' },
];
export function quotePostgresIdentifier(identifier) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(identifier)) {
        throw new Error(`Invalid lowercase PostgreSQL schema identifier: ${identifier}`);
    }
    return `"${identifier.replace(/"/g, '""')}"`;
}
export function resolveRuntimePostgresPoolMax(env = process.env) {
    const raw = env.GANTRY_POSTGRES_POOL_MAX?.trim();
    if (!raw)
        return DEFAULT_RUNTIME_POSTGRES_POOL_MAX;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error('GANTRY_POSTGRES_POOL_MAX must be a positive integer.');
    }
    return parsed;
}
function readLatestPostgresMigration() {
    const latest = readMigrationFiles({
        migrationsFolder: postgresMigrationsFolder,
    }).at(-1);
    if (!latest) {
        throw new Error('No Postgres migrations are registered.');
    }
    return {
        createdAt: latest.folderMillis,
        hash: latest.hash,
    };
}
export function resolvePostgresPoolConfig(url, schema, security = {}) {
    const parsed = parsePostgresConnectionUrl(url);
    const sslMode = parsed.searchParams.get('sslmode')?.trim().toLowerCase();
    const searchPathOptions = `-c search_path=${quotePostgresIdentifier(schema)},public`;
    parsed.searchParams.set('options', searchPathOptions);
    const connectionString = parsed.toString();
    const isLocal = isLocalPostgresHost(parsed.hostname, security.plaintextHostAllowlist);
    if (!isLocal) {
        if (!sslMode ||
            sslMode === 'disable' ||
            sslMode === 'allow' ||
            sslMode === 'prefer') {
            throw new Error('Remote postgres URL must set sslmode=require (or stronger) for secure transport');
        }
        return {
            connectionString,
            options: searchPathOptions,
            max: resolveRuntimePostgresPoolMax(),
            ssl: { rejectUnauthorized: true },
        };
    }
    return {
        connectionString,
        options: searchPathOptions,
        max: resolveRuntimePostgresPoolMax(),
    };
}
export class PostgresStorageService {
    url;
    schemaName;
    security;
    pool;
    db;
    constructor(url, schemaName, security = {}) {
        this.url = url;
        this.schemaName = schemaName;
        this.security = security;
        this.pool = new Pool(resolvePostgresPoolConfig(url, schemaName, security));
        this.db = drizzlePg(this.pool, { schema: pgSchema });
    }
    async migrate() {
        await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${quotePostgresIdentifier(this.schemaName)}`);
        await this.ensurePgcryptoExtension();
        await this.runSchemaMigrationsUnderLock();
        await seedDefaultRuntimeData(this.db);
        await this.migratePgBoss();
    }
    async assertMigrationsCurrent() {
        const latest = readLatestPostgresMigration();
        const migrationsTable = `${quotePostgresIdentifier(this.schemaName)}.${quotePostgresIdentifier('__drizzle_migrations')}`;
        let result;
        try {
            result = await this.pool.query(`SELECT 1 AS applied FROM ${migrationsTable} WHERE created_at = $1 AND hash = $2 LIMIT 1`, [latest.createdAt, latest.hash]);
        }
        catch (err) {
            throw new Error(`Postgres schema migrations are not current: expected migration timestamp ${latest.createdAt} before runtime starts.`, { cause: err });
        }
        if (!result.rows[0]) {
            throw new Error(`Postgres schema migrations are not current: expected migration timestamp ${latest.createdAt} before runtime starts.`);
        }
        await this.assertDefaultRuntimeDataSeeded();
    }
    async assertDefaultRuntimeDataSeeded() {
        const table = (name) => `${quotePostgresIdentifier(this.schemaName)}.${quotePostgresIdentifier(name)}`;
        const expectedToolIds = DEFAULT_TOOL_CATALOG.map((tool) => tool.id);
        const expectedSkillIds = DEFAULT_SKILL_CATALOG.map((skill) => skill.id);
        const result = await this.pool.query(`SELECT (
          EXISTS (SELECT 1 FROM ${table('apps')} WHERE id = $1)
          AND EXISTS (SELECT 1 FROM ${table('llm_profiles')} WHERE id = $2)
          AND EXISTS (SELECT 1 FROM ${table('sandbox_profiles')} WHERE id = $3)
          AND EXISTS (SELECT 1 FROM ${table('agents')} WHERE id = $4)
          AND EXISTS (SELECT 1 FROM ${table('permission_policies')} WHERE id = $5)
          AND EXISTS (SELECT 1 FROM ${table('agent_config_versions')} WHERE id = $6)
          AND EXISTS (SELECT 1 FROM ${table('permission_rules')} WHERE id = $7)
          AND (
            SELECT count(*)::int FROM ${table('tool_catalog')}
            WHERE id = ANY($8::text[])
          ) = $9
          AND (
            SELECT count(*)::int FROM ${table('skill_catalog')}
            WHERE id = ANY($10::text[])
          ) = $11
        ) AS ready`, [
            DEFAULT_APP_ID,
            DEFAULT_LLM_PROFILE_ID,
            DEFAULT_SANDBOX_PROFILE_ID,
            DEFAULT_AGENT_ID,
            DEFAULT_PERMISSION_POLICY_ID,
            DEFAULT_AGENT_CONFIG_VERSION_ID,
            DEFAULT_PERMISSION_RULE_ID,
            expectedToolIds,
            expectedToolIds.length,
            expectedSkillIds,
            expectedSkillIds.length,
        ]);
        if (!result.rows[0]?.ready) {
            throw new Error('Postgres runtime seed data is not current; run bootstrap migrations before starting this runtime role.');
        }
    }
    /**
     * Run the drizzle migrator under the shared cross-instance advisory lock so
     * concurrent migrators (entrypoint passes and runtime boots, in any mix)
     * serialize: the lock holder migrates, the rest block then find nothing
     * pending. The lock is session-scoped — it is released automatically if the
     * holder crashes mid-migration.
     */
    async runSchemaMigrationsUnderLock() {
        const client = await this.pool.connect();
        try {
            await client.query('SELECT pg_advisory_lock($1, $2)', [
                RUNTIME_MIGRATION_LOCK_NAMESPACE,
                RUNTIME_MIGRATION_LOCK_KEY,
            ]);
            await migratePostgres(this.db, {
                migrationsFolder: postgresMigrationsFolder,
                migrationsSchema: this.schemaName,
            });
        }
        finally {
            try {
                await client.query('SELECT pg_advisory_unlock($1, $2)', [
                    RUNTIME_MIGRATION_LOCK_NAMESPACE,
                    RUNTIME_MIGRATION_LOCK_KEY,
                ]);
            }
            finally {
                client.release();
            }
        }
    }
    async ensurePgcryptoExtension() {
        const client = await this.pool.connect();
        try {
            await client.query('SELECT pg_advisory_lock($1, $2)', [
                PGCRYPTO_EXTENSION_LOCK_NAMESPACE,
                PGCRYPTO_EXTENSION_LOCK_KEY,
            ]);
            const existing = await client.query(`SELECT n.nspname AS schema_name
         FROM pg_extension e
         JOIN pg_namespace n ON n.oid = e.extnamespace
         WHERE e.extname = 'pgcrypto'`);
            const currentSchema = existing.rows[0]?.schema_name;
            if (!currentSchema) {
                await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public');
            }
            else if (currentSchema !== 'public') {
                await client.query('ALTER EXTENSION pgcrypto SET SCHEMA public');
            }
        }
        finally {
            try {
                await client.query('SELECT pg_advisory_unlock($1, $2)', [
                    PGCRYPTO_EXTENSION_LOCK_NAMESPACE,
                    PGCRYPTO_EXTENSION_LOCK_KEY,
                ]);
            }
            finally {
                client.release();
            }
        }
    }
    async migratePgBoss() {
        const poolConfig = resolvePostgresPoolConfig(this.url, this.schemaName, this.security);
        const boss = new PgBoss({
            connectionString: poolConfig.connectionString,
            schema: 'pgboss',
            createSchema: true,
            migrate: true,
            schedule: false,
            supervise: false,
            ...(poolConfig.ssl ? { ssl: poolConfig.ssl } : {}),
        });
        await boss.start();
        await boss.stop({ graceful: true, close: true, timeout: 10_000 });
    }
    async healthCheck() {
        await this.pool.query('SELECT 1');
        const caps = await this.pool.query(`WITH required_runtime_event_indexes(index_name) AS (
          VALUES
            ('idx_runtime_events_app_cursor'),
            ('idx_runtime_events_session_cursor'),
            ('idx_runtime_events_run_cursor'),
            ('idx_runtime_events_job_cursor'),
            ('idx_runtime_events_trigger_cursor'),
            ('idx_runtime_events_conversation_thread_cursor'),
            ('idx_runtime_events_type_cursor'),
            ('idx_runtime_events_webhook_projection')
        ),
        required_event_bus_outbox_indexes(index_name) AS (
          VALUES
            ('idx_event_bus_outbox_claim_due'),
            ('idx_event_bus_outbox_app_event'),
            ('idx_event_bus_outbox_runtime_event'),
            ('idx_event_bus_outbox_pending_runtime_event')
        ),
        current_schema_name AS (
          SELECT $1::text AS schema_name
        ),
        required_identity_primary_keys(table_name, column_name) AS (
          SELECT identity_key."tableName", identity_key."columnName"
          FROM jsonb_to_recordset($2::jsonb)
            AS identity_key("tableName" text, "columnName" text)
        ),
        event_tables AS (
          SELECT
            to_regclass(format('%I.%I', $1::text, 'runtime_events')) AS runtime_events_oid,
            to_regclass(format('%I.%I', $1::text, 'event_bus_outbox')) AS event_bus_outbox_oid
        )
        SELECT
          EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_vector,
          EXISTS(SELECT 1 FROM pg_extension WHERE extname IN ('pg_trgm', 'pg_search')) AS has_text_search,
          (to_regclass('pgboss.version') IS NOT NULL) AS has_job_queue,
          ((SELECT runtime_events_oid FROM event_tables) IS NOT NULL) AS has_runtime_events_table,
          ARRAY(
            SELECT format('%s.%s', required.table_name, required.column_name)
            FROM required_identity_primary_keys required
            CROSS JOIN current_schema_name csn
            LEFT JOIN pg_namespace n
              ON n.nspname = csn.schema_name
            LEFT JOIN pg_class c
              ON c.relnamespace = n.oid
             AND c.relname = required.table_name
             AND c.relkind IN ('r', 'p')
            LEFT JOIN pg_attribute a
              ON a.attrelid = c.oid
             AND a.attname = required.column_name
             AND NOT a.attisdropped
            LEFT JOIN pg_attrdef d
              ON d.adrelid = a.attrelid
             AND d.adnum = a.attnum
            WHERE a.attnum IS NULL
               OR (a.attidentity = '' AND d.adbin IS NULL)
            ORDER BY required.table_name, required.column_name
          ) AS missing_generated_identity_primary_keys,
          ((SELECT event_bus_outbox_oid FROM event_tables) IS NOT NULL) AS has_event_bus_outbox_table,
          EXISTS(
            SELECT 1
            FROM pg_constraint c
            JOIN event_tables t ON c.conrelid = t.event_bus_outbox_oid
            WHERE c.conname = 'event_bus_outbox_runtime_event_id_key'
              AND c.contype = 'u'
          ) AS has_event_bus_outbox_runtime_event_unique,
          ARRAY(
            SELECT r.index_name
            FROM required_runtime_event_indexes r
            CROSS JOIN current_schema_name s
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_indexes i
              WHERE i.schemaname = s.schema_name
                AND i.tablename = 'runtime_events'
                AND i.indexname = r.index_name
            )
            ORDER BY r.index_name
          ) AS missing_runtime_event_indexes,
          ARRAY(
            SELECT r.index_name
            FROM required_event_bus_outbox_indexes r
            CROSS JOIN current_schema_name s
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_indexes i
              WHERE i.schemaname = s.schema_name
                AND i.tablename = 'event_bus_outbox'
                AND i.indexname = r.index_name
            )
            ORDER BY r.index_name
          ) AS missing_event_bus_outbox_indexes`, [this.schemaName, JSON.stringify(GENERATED_ALWAYS_IDENTITY_PRIMARY_KEYS)]);
        const row = caps.rows[0];
        const hasVector = Boolean(row?.has_vector);
        const hasTextSearch = Boolean(row?.has_text_search);
        const hasJobQueue = Boolean(row?.has_job_queue);
        const hasRuntimeEventsTable = Boolean(row?.has_runtime_events_table);
        const missingGeneratedIdentityPrimaryKeys = row?.missing_generated_identity_primary_keys ?? [];
        const missingGeneratedIdentityDiagnostics = missingGeneratedIdentityPrimaryKeys
            .filter((identityKey) => hasRuntimeEventsTable || identityKey !== 'runtime_events.event_id')
            .map((identityKey) => `${identityKey} identity/default is missing`);
        const hasEventBusOutboxTable = Boolean(row?.has_event_bus_outbox_table);
        const hasEventBusOutboxRuntimeEventUnique = Boolean(row?.has_event_bus_outbox_runtime_event_unique);
        const missingRuntimeEventIndexes = row?.missing_runtime_event_indexes ?? [];
        const missingEventBusOutboxIndexes = row?.missing_event_bus_outbox_indexes ?? [];
        const hasRuntimeEvents = hasRuntimeEventsTable &&
            missingGeneratedIdentityPrimaryKeys.length === 0 &&
            missingRuntimeEventIndexes.length === 0;
        const hasEventBusOutbox = hasEventBusOutboxTable &&
            hasEventBusOutboxRuntimeEventUnique &&
            missingEventBusOutboxIndexes.length === 0;
        return {
            lexicalSearch: hasTextSearch,
            vectorSearch: hasVector,
            vectorReason: hasVector
                ? undefined
                : 'pgvector extension is not installed',
            textSearch: hasTextSearch,
            textSearchReason: hasTextSearch
                ? undefined
                : 'pg_search or pg_trgm extension is not installed',
            jobQueue: hasJobQueue,
            jobQueueReason: hasJobQueue
                ? undefined
                : 'pg-boss schema is not initialized (expected table pgboss.version)',
            runtimeEvents: hasRuntimeEvents,
            runtimeEventsReason: hasRuntimeEvents
                ? undefined
                : [
                    hasRuntimeEventsTable
                        ? undefined
                        : 'runtime_events table is missing',
                    ...missingGeneratedIdentityDiagnostics,
                    hasRuntimeEventsTable && missingRuntimeEventIndexes.length
                        ? `runtime_events indexes are missing: ${missingRuntimeEventIndexes.join(', ')}`
                        : undefined,
                ]
                    .filter(Boolean)
                    .join('; '),
            eventBusOutbox: hasEventBusOutbox,
            eventBusOutboxReason: hasEventBusOutbox
                ? undefined
                : [
                    hasEventBusOutboxTable
                        ? undefined
                        : 'event_bus_outbox table is missing',
                    hasEventBusOutboxTable && !hasEventBusOutboxRuntimeEventUnique
                        ? 'event_bus_outbox runtime-event uniqueness constraint is missing: event_bus_outbox_runtime_event_id_key'
                        : undefined,
                    hasEventBusOutboxTable && missingEventBusOutboxIndexes.length
                        ? `event_bus_outbox indexes are missing: ${missingEventBusOutboxIndexes.join(', ')}`
                        : undefined,
                ]
                    .filter(Boolean)
                    .join('; '),
        };
    }
    async close() {
        await this.pool.end();
    }
}
export function createStorageService(config) {
    if (!config.postgresUrl?.trim()) {
        throw new Error(`${config.postgresUrlEnv} is required for runtime storage`);
    }
    return new PostgresStorageService(config.postgresUrl, config.postgresSchema, {
        plaintextHostAllowlist: config.postgresPlaintextHostAllowlist,
    });
}
