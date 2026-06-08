import * as p from '@clack/prompts';

import { CapabilitySecretService } from '../application/capability-secrets/capability-secret-service.js';
import { ModelCredentialService } from '../application/model-credentials/model-credential-service.js';
import type { AppId } from '../domain/app/app.js';
import { normalizeCapabilitySecretName } from '../domain/capability-secrets/capability-secrets.js';
import {
  listSupportedModelCredentialProviders,
  normalizeModelCredentialProvider,
} from '../domain/model-credentials/model-credentials.js';
import {
  getDefaultModelRouteProvider,
  getModelProviderDefinition,
  resolveModelCredentialMode,
  type ModelCredentialPayload,
} from '../shared/model-provider-registry.js';
import {
  DEFAULT_SETUP_MODEL_ALIAS,
  resolveModelSelectionForWorkload,
} from '../shared/model-catalog.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';

const DEFAULT_APP_ID = 'default' as AppId;

function usage(): string {
  return [
    'Usage:',
    '  gantry credentials model status|doctor',
    '  gantry credentials model set <provider>',
    '  gantry credentials model rotate <provider>',
    '  gantry credentials model disable <provider>',
    '  gantry credentials capability list',
    '  gantry credentials capability set <NAME> [--allow <capabilityId>]',
    '  gantry credentials capability import-env <NAME> [--allow <capabilityId>]',
    '  gantry credentials capability unset <NAME>',
    '  gantry credentials browser status',
  ].join('\n');
}

export async function runCredentialsCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [scope, action, name, ...rest] = args;
  try {
    if (scope === 'model') {
      return await runModelCredentialCommand(runtimeHome, action, name, rest);
    }
    if (scope === 'capability') {
      return await runCapabilityCredentialCommand(
        runtimeHome,
        action,
        name,
        rest,
      );
    }
    if (scope === 'browser') {
      if (action && action !== 'status') {
        p.log.error(
          'Browser credentials only report profile/session status. Use `gantry credentials browser status`.',
        );
        return 1;
      }
      const { runBrowserCommand } = await import('./browser.js');
      return runBrowserCommand(runtimeHome, ['status']);
    }
  } catch (error) {
    p.log.error(
      error instanceof Error ? error.message : 'Credentials command failed',
    );
    return 1;
  }
  p.note(usage(), 'Gantry Credentials');
  return 1;
}

async function withCredentialServices<T>(
  runtimeHome: string,
  fn: (services: {
    model: ModelCredentialService;
    capability: CapabilitySecretService;
  }) => Promise<T>,
): Promise<T> {
  process.env.GANTRY_HOME = runtimeHome;
  const { createStorageRuntime } =
    await import('../adapters/storage/postgres/factory.js');
  const storage = createStorageRuntime();
  try {
    await storage.service.migrate();
    return await fn({
      model: new ModelCredentialService(
        storage.repositories.modelCredentials,
        (event) => storage.runtimeEvents.publish(event),
      ),
      capability: new CapabilitySecretService(
        storage.repositories.capabilitySecrets,
        (event) => storage.runtimeEvents.publish(event),
      ),
    });
  } finally {
    await storage.runtimeEventNotifier.close();
    await storage.service.close();
  }
}

export async function storeModelCredentialInput(input: {
  runtimeHome: string;
  providerId: string;
  authMode: string;
  payload: ModelCredentialPayload;
}): Promise<void> {
  const providerId = normalizeModelCredentialProvider(input.providerId);
  await withCredentialServices(input.runtimeHome, ({ model }) =>
    model.set({
      appId: DEFAULT_APP_ID,
      providerId,
      authMode: input.authMode,
      payload: input.payload,
      actor: 'cli',
    }),
  );
}

async function runModelCredentialCommand(
  runtimeHome: string,
  action = 'status',
  provider = '',
  _args: string[],
): Promise<number> {
  if (action === 'status' || !action) {
    const rows = await withCredentialServices(runtimeHome, ({ model }) =>
      model.list({ appId: DEFAULT_APP_ID }),
    );
    p.note(
      rows.map(formatModelCredentialStatusRow).join('\n'),
      'Model Credentials',
    );
    return 0;
  }

  if (action === 'doctor') {
    const requiredProviderId = requiredModelCredentialProvider(runtimeHome);
    const rows = await withCredentialServices(runtimeHome, ({ model }) =>
      model.list({ appId: DEFAULT_APP_ID }),
    );
    const credential = rows.find(
      (row) => row.providerId === requiredProviderId,
    );
    const providerLabel =
      getModelProviderDefinition(requiredProviderId)?.label ??
      requiredProviderId;
    if (credential?.configured) {
      p.log.success(
        `Gantry Model Access is ready for the default ${providerLabel} route.`,
      );
      return 0;
    }
    p.log.error(
      `Gantry Model Access is missing the default ${providerLabel} credential. Run \`gantry credentials model set ${requiredProviderId}\`.`,
    );
    return 1;
  }

  if (action === 'set' || action === 'rotate') {
    const providerId = normalizeModelCredentialProvider(provider);
    if (action === 'rotate') {
      const rows = await withCredentialServices(runtimeHome, ({ model }) =>
        model.list({ appId: DEFAULT_APP_ID }),
      );
      const existing = rows.find((row) => row.providerId === providerId);
      if (!existing?.configured || !existing.authMode) {
        p.log.error(
          `${providerId} model credential must be active before rotation. Run \`gantry credentials model set ${providerId}\`.`,
        );
        return 1;
      }
      const credentialInput = await promptModelCredentialPayload(providerId, {
        authMode: existing.authMode,
        partial: true,
      });
      if (!credentialInput) {
        p.outro('Credential unchanged.');
        return 1;
      }
      await withCredentialServices(runtimeHome, ({ model }) =>
        model.rotate({
          appId: DEFAULT_APP_ID,
          providerId,
          payload: credentialInput.payload,
          actor: 'cli',
        }),
      );
      p.log.success(`Rotated ${providerId} model credential.`);
      return 0;
    }
    const credentialInput = await promptModelCredentialPayload(providerId);
    if (!credentialInput) {
      p.outro('Credential unchanged.');
      return 1;
    }
    await withCredentialServices(runtimeHome, ({ model }) =>
      model.set({
        appId: DEFAULT_APP_ID,
        providerId,
        authMode: credentialInput.authMode,
        payload: credentialInput.payload,
        actor: 'cli',
      }),
    );
    p.log.success(`Stored ${providerId} model credential.`);
    return 0;
  }

  if (action === 'disable') {
    const providerId = normalizeModelCredentialProvider(provider);
    const disabled = await withCredentialServices(runtimeHome, ({ model }) =>
      model.disable({
        appId: DEFAULT_APP_ID,
        providerId,
        actor: 'cli',
      }),
    );
    if (disabled) p.log.success(`Disabled ${providerId} model credential.`);
    else p.log.info(`${providerId} model credential was not configured.`);
    return 0;
  }

  p.note(
    `Supported providers: ${listSupportedModelCredentialProviders().join(', ')}`,
    'Model Credentials',
  );
  return 1;
}

export async function promptModelCredentialPayload(
  providerId: string,
  options: { authMode?: string; partial?: boolean } = {},
): Promise<
  | {
      authMode: string;
      payload: ModelCredentialPayload;
    }
  | undefined
> {
  const provider = getModelProviderDefinition(providerId);
  if (!provider) {
    throw new Error(`Unsupported model credential provider: ${providerId}`);
  }
  const authMode =
    options.authMode ??
    (provider.credentialModes.length === 1
      ? provider.credentialModes[0]!.id
      : await p.select({
          message: 'Authentication mode',
          options: provider.credentialModes.map((mode) => ({
            value: mode.id,
            label: mode.label,
            hint: mode.helpText,
          })),
        }));
  if (p.isCancel(authMode)) return undefined;
  const mode = resolveModelCredentialMode(provider, String(authMode));
  if (mode.helpText) p.log.info(mode.helpText);
  const payload: ModelCredentialPayload = {};
  for (const field of mode.fields) {
    const message = options.partial
      ? `${field.label} (leave blank to keep current)`
      : field.label;
    const value = field.secret
      ? await p.password({
          message,
          validate: (input) =>
            options.partial || !field.required || input?.trim()
              ? undefined
              : `${field.label} is required.`,
        })
      : await p.text({
          message,
          validate: (input) =>
            options.partial || !field.required || input?.trim()
              ? undefined
              : `${field.label} is required.`,
        });
    if (p.isCancel(value)) return undefined;
    if (String(value).trim()) payload[field.name] = String(value).trim();
  }
  return { authMode: mode.id, payload };
}

function formatModelCredentialStatusRow(
  row: Awaited<ReturnType<ModelCredentialService['list']>>[number],
): string {
  const mode = row.credentialModes.find((item) => item.id === row.authMode);
  const configuredFieldLabels = row.configuredFields.map((field) => {
    const label = mode?.fields.find((item) => item.name === field)?.label;
    return label ?? field;
  });
  return [
    `${row.providerId}: ${row.health}`,
    `  label: ${row.label}`,
    `  role: ${formatModelCredentialRole(row.role)}`,
    row.authMode ? `  auth mode: ${mode?.label ?? row.authMode}` : undefined,
    `  secret status: ${formatSecretStatus(row.health)}`,
    row.health === 'ready'
      ? `  runtime access: ${formatModelCredentialRuntimeAccess(row.authMode)}`
      : undefined,
    configuredFieldLabels.length > 0
      ? `  configured: ${configuredFieldLabels.join(', ')}`
      : undefined,
    row.fingerprint ? `  fingerprint: ${row.fingerprint}` : undefined,
    row.updatedAt ? `  updated: ${row.updatedAt}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatModelCredentialRole(role: string): string {
  if (role === 'model_route') return 'model route';
  if (role === 'embedding_provider') return 'embedding provider';
  return role;
}

function formatSecretStatus(health: string): string {
  if (health === 'ready') return 'stored, encrypted, active';
  if (health === 'disabled') return 'stored, encrypted, disabled';
  return 'not stored';
}

function formatModelCredentialRuntimeAccess(authMode: string | null): string {
  if (authMode === 'claude_code_oauth') return 'via Claude Code OAuth';
  return 'via Gantry Model Gateway';
}

function requiredModelCredentialProvider(runtimeHome: string): string {
  const settings = ensureRuntimeSettings(runtimeHome);
  const resolved = resolveModelSelectionForWorkload(
    settings.agent.defaultModel || DEFAULT_SETUP_MODEL_ALIAS,
    'chat',
  );
  if (!resolved.ok) {
    const provider = getDefaultModelRouteProvider();
    if (!provider) {
      throw new Error('No model route provider is registered.');
    }
    return provider.id;
  }
  return resolved.entry.modelRoute.id;
}

async function runCapabilityCredentialCommand(
  runtimeHome: string,
  action = '',
  name = '',
  args: string[],
): Promise<number> {
  if (action === 'list') return await listCapabilitySecrets(runtimeHome);
  if (action === 'set')
    return await setCapabilitySecret(runtimeHome, name, args);
  if (action === 'import-env') {
    return await importCapabilityEnvSecret(runtimeHome, name, args);
  }
  if (action === 'unset') return await unsetCapabilitySecret(runtimeHome, name);
  p.note(usage(), 'Capability Credentials');
  return 1;
}

async function listCapabilitySecrets(runtimeHome: string): Promise<number> {
  const { secrets, statuses } = await withCredentialServices(
    runtimeHome,
    async ({ capability }) => {
      const secrets = await capability.list({ appId: DEFAULT_APP_ID });
      const statuses = new Map(
        await Promise.all(
          secrets.map(
            async (secret) =>
              [
                secret.name,
                await capability.status({
                  appId: DEFAULT_APP_ID,
                  name: secret.name,
                }),
              ] as const,
          ),
        ),
      );
      return { secrets, statuses };
    },
  );
  if (secrets.length === 0) {
    p.note('No capability secrets are configured.', 'Capability Credentials');
    return 0;
  }
  p.note(
    secrets
      .map((secret) =>
        [
          `${secret.name}: ${statuses.get(secret.name) === 'ready' ? 'ready' : 'needs reset'}`,
          secret.allowedCapabilityIds.length > 0
            ? `  allowed: ${secret.allowedCapabilityIds.join(', ')}`
            : undefined,
          `  updated: ${secret.updatedAt}`,
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n'),
    'Capability Credentials',
  );
  return 0;
}

async function setCapabilitySecret(
  runtimeHome: string,
  name = '',
  args: string[],
): Promise<number> {
  const parsed = parseCapabilitySecretArgs(args);
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
  await withCredentialServices(runtimeHome, ({ capability }) =>
    capability.set({
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

async function importCapabilityEnvSecret(
  runtimeHome: string,
  name = '',
  args: string[],
): Promise<number> {
  const parsed = parseCapabilitySecretArgs(args);
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
  await withCredentialServices(runtimeHome, ({ capability }) =>
    capability.set({
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

async function unsetCapabilitySecret(
  runtimeHome: string,
  name = '',
): Promise<number> {
  if (!name.trim()) {
    p.log.error('Missing secret name.');
    return 1;
  }
  const normalizedName = normalizeCapabilitySecretName(name);
  const deleted = await withCredentialServices(runtimeHome, ({ capability }) =>
    capability.unset({
      appId: DEFAULT_APP_ID,
      name: normalizedName,
      actor: 'cli',
    }),
  );
  if (deleted) p.log.success(`Removed ${normalizedName}.`);
  else p.log.info(`${normalizedName} was not configured.`);
  return 0;
}

function parseCapabilitySecretArgs(args: string[]): {
  allowedCapabilityIds: string[];
} {
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
