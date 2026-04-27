import * as p from '@clack/prompts';

import { readEnvFile } from '../config/env/file.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';
import { inspectRuntimeStorageReadiness } from '../adapters/storage/postgres/storage-readiness.js';
import {
  inspectOnecliPersistenceReadiness,
  ONECLI_DATABASE_URL_ENV,
  ONECLI_DEFAULT_SCHEMA,
  ONECLI_SECRET_ENCRYPTION_KEY_ENV,
} from '../adapters/credentials/onecli/local/persistence.js';

const LOCAL_ONECLI_URL = 'http://localhost:10254';

function composeGuidance(): string {
  return [
    'MyClaw does not create or manage Docker containers.',
    'For a local database and local Model Access, use the root docker-compose.yml yourself:',
    '',
    '  docker compose --env-file ~/myclaw/.env up -d',
    '',
    'Then run `myclaw setup` and paste the Postgres URLs.',
    `Normal setup uses OneCLI at ${LOCAL_ONECLI_URL}.`,
  ].join('\n');
}

function localEnvSummary(runtimeHome: string): string {
  const env = readEnvFile(envFilePath(runtimeHome));
  let onecliDatabaseUrlEnv = ONECLI_DATABASE_URL_ENV;
  let onecliUrl = LOCAL_ONECLI_URL;
  let onecliSchema = ONECLI_DEFAULT_SCHEMA;
  let myclawSchema = 'myclaw';
  try {
    const settings = ensureRuntimeSettings(runtimeHome);
    onecliDatabaseUrlEnv = settings.credentialBroker.onecli.postgres.urlEnv;
    onecliUrl = settings.credentialBroker.onecli.url || LOCAL_ONECLI_URL;
    onecliSchema = settings.credentialBroker.onecli.postgres.schema;
    myclawSchema = settings.storage.postgres.schema;
  } catch {
    // local guidance must work before setup creates settings.yaml.
  }
  return [
    `MYCLAW_DATABASE_URL: ${env.MYCLAW_DATABASE_URL ? 'configured' : 'missing'}`,
    `${onecliDatabaseUrlEnv}: ${env[onecliDatabaseUrlEnv] ? 'configured' : 'missing'}`,
    `OneCLI URL: ${onecliUrl} (settings.yaml credential_broker.onecli.url)`,
    `MyClaw schema: ${myclawSchema}`,
    `OneCLI schema: ${onecliSchema}`,
  ].join('\n');
}

async function runLocalDoctor(runtimeHome: string): Promise<number> {
  const env = readEnvFile(envFilePath(runtimeHome));
  let onecliDatabaseUrlEnv = ONECLI_DATABASE_URL_ENV;
  let onecliSchema = ONECLI_DEFAULT_SCHEMA;
  let myclawSchema = 'myclaw';
  try {
    const settings = ensureRuntimeSettings(runtimeHome);
    onecliDatabaseUrlEnv = settings.credentialBroker.onecli.postgres.urlEnv;
    onecliSchema = settings.credentialBroker.onecli.postgres.schema;
    myclawSchema = settings.storage.postgres.schema;
  } catch {
    // local doctor still reports config/env state before setup is complete.
  }

  const storage = await inspectRuntimeStorageReadiness(runtimeHome);
  const onecliPersistence = await inspectOnecliPersistenceReadiness({
    postgresUrl: env[onecliDatabaseUrlEnv]?.trim() || '',
    schema: onecliSchema,
    secretEncryptionKey: env[ONECLI_SECRET_ENCRYPTION_KEY_ENV]?.trim() || '',
    myclawPostgresUrl: env.MYCLAW_DATABASE_URL?.trim() || '',
    myclawSchema,
  });

  p.note(
    [
      localEnvSummary(runtimeHome),
      '',
      `Database readiness: ${storage.status}`,
      storage.message,
      ...(storage.details || []),
      '',
      `OneCLI persistence: ${onecliPersistence.status}`,
      onecliPersistence.message,
      ...(onecliPersistence.details || []),
      '',
      composeGuidance(),
    ].join('\n'),
    'Local Doctor',
  );

  return storage.status === 'fail' || onecliPersistence.status === 'fail'
    ? 1
    : 0;
}

export async function runLocalCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const command = args[0] || 'status';
  if (command === 'setup' || command === 'start') {
    p.note(
      composeGuidance(),
      command === 'setup' ? 'Local Setup' : 'Local Start',
    );
    return 0;
  }
  if (command === 'status') {
    p.note(
      [localEnvSummary(runtimeHome), '', composeGuidance()].join('\n'),
      'Local Status',
    );
    return 0;
  }
  if (command === 'stop') {
    p.note(
      'MyClaw does not stop local databases or OneCLI. Use `docker compose stop` if you started the provided Compose stack.',
      'Local Stop',
    );
    return 0;
  }
  if (command === 'logs') {
    p.note(
      'MyClaw does not own local service logs. Use `docker compose logs --tail 160` for the provided Compose stack.',
      'Local Logs',
    );
    return 0;
  }
  if (command === 'doctor') {
    return runLocalDoctor(runtimeHome);
  }

  p.log.error(
    'Unknown local command. Use setup, start, stop, status, logs, or doctor.',
  );
  return 1;
}
