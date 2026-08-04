import { PostgresStorageService } from './adapters/storage/postgres/storage-service.js';
import { fleetRehearsalPlaintextPostgresHosts } from './adapters/storage/postgres/url.js';
import { readEnvFile } from './config/env/file.js';
import { envFilePath } from './config/settings/runtime-home.js';
import { getGantryHome } from './shared/gantry-home.js';
function env(name) {
    const processValue = process.env[name]?.trim();
    if (processValue)
        return processValue;
    return readEnvFile(envFilePath(getGantryHome()))[name]?.trim() || '';
}
export function resolvePostgresMigrateConfig() {
    const url = env('GANTRY_DATABASE_URL');
    if (!url) {
        throw new Error('GANTRY_DATABASE_URL is required to run migrations.');
    }
    let urlSchema = '';
    try {
        urlSchema = new URL(url).searchParams.get('schema')?.trim() || '';
    }
    catch {
        // PostgresStorageService reports malformed URLs with the canonical message.
    }
    return {
        url,
        schema: env('GANTRY_SETTINGS_POSTGRES_SCHEMA') ||
            urlSchema ||
            env('GANTRY_DB_SCHEMA') ||
            'gantry',
    };
}
export async function runPostgresMigrations(config = resolvePostgresMigrateConfig()) {
    const service = new PostgresStorageService(config.url, config.schema, {
        plaintextHostAllowlist: fleetRehearsalPlaintextPostgresHosts(),
    });
    try {
        await service.migrate();
    }
    finally {
        await service.close();
    }
}
const isDirectRun = process.argv[1] &&
    new URL(import.meta.url).pathname ===
        new URL(`file://${process.argv[1]}`).pathname;
if (isDirectRun) {
    runPostgresMigrations().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`gantry postgres migrate failed: ${message}\n`);
        process.exit(1);
    });
}
