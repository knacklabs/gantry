import * as p from '@clack/prompts';

import { readEnvFile } from '../config/env/file.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';
import { inspectRuntimeStorageReadiness } from '../adapters/storage/postgres/storage-readiness.js';
import { hasValidEncryptionSecret } from '../shared/security-posture.js';

function composeGuidance(): string {
  return [
    'Gantry does not create or manage Docker containers.',
    'For a local database, use the root docker-compose.yml yourself:',
    '',
    '  docker compose --env-file ~/gantry/.env up -d',
    '',
    'Then run `gantry setup` and paste the Gantry Postgres URL.',
    'Model provider keys are stored with `gantry credentials model set <provider>`.',
  ].join('\n');
}

function localEnvSummary(runtimeHome: string): string {
  const env = readEnvFile(envFilePath(runtimeHome));
  let gantrySchema = 'gantry';
  try {
    const settings = ensureRuntimeSettings(runtimeHome);
    gantrySchema = settings.storage.postgres.schema;
  } catch {
    // local guidance must work before setup creates settings.yaml.
  }
  return [
    `GANTRY_DATABASE_URL: ${env.GANTRY_DATABASE_URL ? 'configured' : 'missing'}`,
    `Credential encryption: ${
      hasValidEncryptionSecret({
        SECRET_ENCRYPTION_KEY: env.SECRET_ENCRYPTION_KEY,
        SECRET_ENCRYPTION_KEYRING_JSON: env.SECRET_ENCRYPTION_KEYRING_JSON,
      })
        ? 'configured'
        : 'missing or invalid'
    }`,
    `Gantry schema: ${gantrySchema}`,
  ].join('\n');
}

async function runLocalDoctor(runtimeHome: string): Promise<number> {
  const storage = await inspectRuntimeStorageReadiness(runtimeHome);

  p.note(
    [
      localEnvSummary(runtimeHome),
      '',
      `Database readiness: ${storage.status}`,
      storage.message,
      ...(storage.details || []),
      '',
      composeGuidance(),
    ].join('\n'),
    'Local Doctor',
  );

  return storage.status === 'fail' ? 1 : 0;
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
      'Gantry does not stop local databases. Use `docker compose stop` if you started the provided Compose stack.',
      'Local Stop',
    );
    return 0;
  }
  if (command === 'logs') {
    p.note(
      'Gantry does not own local service logs. Use `docker compose logs --tail 160` for the provided Compose stack.',
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
