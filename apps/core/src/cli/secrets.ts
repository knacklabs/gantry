import * as p from '@clack/prompts';

import { CapabilitySecretService } from '../application/capability-secrets/capability-secret-service.js';
import type { AppId } from '../domain/app/app.js';
import { normalizeCapabilitySecretName } from '../domain/capability-secrets/capability-secrets.js';

const DEFAULT_APP_ID = 'default' as AppId;

function usage(): string {
  return [
    'Usage:',
    '  gantry secrets list',
    '  gantry secrets set <NAME> [--allow <capabilityId>]',
    '  gantry secrets import-env <NAME> [--allow <capabilityId>]',
    '  gantry secrets unset <NAME>',
  ].join('\n');
}

export async function runSecretsCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [action, name, ...rest] = args;
  try {
    if (action === 'list') return await listSecrets(runtimeHome);
    if (action === 'set') return await setSecret(runtimeHome, name, rest);
    if (action === 'import-env')
      return await importEnvSecret(runtimeHome, name, rest);
    if (action === 'unset') return await unsetSecret(runtimeHome, name);
  } catch (error) {
    p.log.error(
      error instanceof Error ? error.message : 'Secrets command failed',
    );
    return 1;
  }
  p.note(usage(), 'Gantry Secrets');
  return 1;
}

async function withSecretsService<T>(
  runtimeHome: string,
  fn: (service: CapabilitySecretService) => Promise<T>,
): Promise<T> {
  process.env.GANTRY_HOME = runtimeHome;
  const { createStorageRuntime } =
    await import('../adapters/storage/postgres/factory.js');
  const storage = createStorageRuntime();
  try {
    await storage.service.migrate();
    return await fn(
      new CapabilitySecretService(storage.repositories.capabilitySecrets),
    );
  } finally {
    await storage.runtimeEventNotifier.close();
    await storage.service.close();
  }
}

async function listSecrets(runtimeHome: string): Promise<number> {
  const secrets = await withSecretsService(runtimeHome, (service) =>
    service.list({ appId: DEFAULT_APP_ID }),
  );
  if (secrets.length === 0) {
    p.note('No capability secrets are configured.', 'Gantry Secrets');
    return 0;
  }
  p.note(
    secrets
      .map((secret) =>
        [
          `${secret.name}: Ready`,
          secret.allowedCapabilityIds.length > 0
            ? `  allowed: ${secret.allowedCapabilityIds.join(', ')}`
            : undefined,
          `  updated: ${secret.updatedAt}`,
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n'),
    'Gantry Secrets',
  );
  return 0;
}

async function setSecret(
  runtimeHome: string,
  name = '',
  args: string[],
): Promise<number> {
  const parsed = parseSecretArgs(args);
  if (!name.trim()) {
    p.log.error('Missing secret name.');
    return 1;
  }
  const normalizedName = normalizeCapabilitySecretName(name);
  const value = await p.password({
    message: `Value for ${normalizedName}`,
    validate: (input) => (input?.trim() ? undefined : 'Value is required.'),
  });
  if (p.isCancel(value)) {
    p.outro('Secret unchanged.');
    return 1;
  }
  await withSecretsService(runtimeHome, (service) =>
    service.set({
      appId: DEFAULT_APP_ID,
      name: normalizedName,
      value,
      actor: 'cli',
      allowedCapabilityIds: parsed.allowedCapabilityIds,
    }),
  );
  p.log.success(`Stored ${normalizedName}.`);
  return 0;
}

async function importEnvSecret(
  runtimeHome: string,
  name = '',
  args: string[],
): Promise<number> {
  const parsed = parseSecretArgs(args);
  if (!name.trim()) {
    p.log.error('Missing secret name.');
    return 1;
  }
  const normalizedName = normalizeCapabilitySecretName(name);
  const value = process.env[normalizedName];
  if (!value) {
    p.log.error(`${normalizedName} is not set in this shell environment.`);
    return 1;
  }
  await withSecretsService(runtimeHome, (service) =>
    service.set({
      appId: DEFAULT_APP_ID,
      name: normalizedName,
      value,
      actor: 'cli',
      allowedCapabilityIds: parsed.allowedCapabilityIds,
    }),
  );
  p.log.success(`Imported ${normalizedName}.`);
  return 0;
}

async function unsetSecret(runtimeHome: string, name = ''): Promise<number> {
  if (!name.trim()) {
    p.log.error('Missing secret name.');
    return 1;
  }
  const normalizedName = normalizeCapabilitySecretName(name);
  const deleted = await withSecretsService(runtimeHome, (service) =>
    service.unset({ appId: DEFAULT_APP_ID, name: normalizedName }),
  );
  if (deleted) p.log.success(`Removed ${normalizedName}.`);
  else p.log.info(`${normalizedName} was not configured.`);
  return 0;
}

function parseSecretArgs(args: string[]): { allowedCapabilityIds: string[] } {
  const allowedCapabilityIds: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--allow') {
      const value = args[index + 1]?.trim();
      if (value) allowedCapabilityIds.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--allow=')) {
      const value = arg.slice('--allow='.length).trim();
      if (value) allowedCapabilityIds.push(value);
    }
  }
  return { allowedCapabilityIds };
}
