import fs from 'fs';
import path from 'path';
import '../channels/register-builtins.js';
import {
  getProvider,
  listConnectableChannelProviders,
} from '../channels/provider-registry.js';
import { readEnvFile } from '../config/env/file.js';
import {
  assertRuntimeEntryExists,
  getRuntimeEntryPath,
} from '../infrastructure/service/package-paths.js';
import {
  commandExists,
  detectPlatform,
  getNodeMajorVersion,
  getNodeVersion,
  hasSystemdUser,
} from '../infrastructure/service/platform.js';
import {
  envFilePath,
  ensureRuntimeWritable,
} from '../config/settings/runtime-home.js';
import {
  ensureRuntimeSettings,
  RuntimeSettings,
} from '../config/settings/runtime-settings.js';
import { validateTelegramBotToken } from './telegram.js';
import { inspectMemoryHealth } from './memory-health.js';
import { validatePostgresConnectionUrl } from '../adapters/storage/postgres/url.js';
import { inspectRuntimeStorageReadiness } from '../adapters/storage/postgres/storage-readiness.js';
import {
  inspectOnecliPersistenceReadiness,
  ONECLI_SECRET_ENCRYPTION_KEY_ENV,
  validateOnecliDatabaseUrl,
} from '../adapters/credentials/onecli/local/persistence.js';
import { validateOnecliUrl } from '../adapters/credentials/onecli/policy.js';
import { validateExternalBrokerUrl } from '../config/credentials/broker-url-policy.js';
import { validateRuntimeEnvPolicy } from '../config/source-classification.js';
import { openRuntimeGroupDb } from './runtime-group-db.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

const ONECLI_DOCTOR_TIMEOUT_MS = 3_000;
export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorStatus;
  message: string;
  nextAction?: string;
}

export interface DoctorReport {
  ok: boolean;
  blockingFailures: number;
  warnings: number;
  checks: DoctorCheck[];
}

function resolveRuntimeEnvValue(
  env: Record<string, string>,
  key: string,
): string {
  return env[key]?.trim() || process.env[key]?.trim() || '';
}

export interface DoctorNetworkOptions {
  validateTelegramToken?: boolean;
  telegramTimeoutMs?: number;
}

function statusLabel(status: DoctorStatus): string {
  if (status === 'pass') return 'PASS';
  if (status === 'warn') return 'WARN';
  return 'FAIL';
}

function add(checks: DoctorCheck[], check: DoctorCheck): void {
  checks.push(check);
}

function addToReport(report: DoctorReport, check: DoctorCheck): DoctorReport {
  const checks = [...report.checks, check];
  const blockingFailures = checks.filter(
    (entry) => entry.status === 'fail',
  ).length;
  const warnings = checks.filter((entry) => entry.status === 'warn').length;
  return {
    checks,
    blockingFailures,
    warnings,
    ok: blockingFailures === 0,
  };
}

function loadSettingsForDoctor(runtimeHome: string): {
  settings?: RuntimeSettings;
  error?: string;
} {
  try {
    return { settings: ensureRuntimeSettings(runtimeHome) };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function runDoctor(
  importMetaUrl: string,
  runtimeHome: string,
): DoctorReport {
  const checks: DoctorCheck[] = [];

  const nodeMajor = getNodeMajorVersion();
  const nodeVersion = getNodeVersion();
  if (nodeMajor >= 24 && nodeMajor < 26) {
    add(checks, {
      id: 'node-version',
      title: 'Node.js Version',
      status: 'pass',
      message: `Node ${nodeVersion} detected.`,
    });
  } else {
    add(checks, {
      id: 'node-version',
      title: 'Node.js Version',
      status: 'fail',
      message: `Node ${nodeVersion} detected. Gantry requires Node >=24 <26.`,
      nextAction: 'Install Node.js 24 or 25 and run `gantry doctor` again.',
    });
  }

  try {
    assertRuntimeEntryExists(importMetaUrl);
    add(checks, {
      id: 'runtime-entry',
      title: 'Runtime Files',
      status: 'pass',
      message: `Runtime entry found at ${getRuntimeEntryPath(importMetaUrl)}.`,
    });
  } catch (err) {
    add(checks, {
      id: 'runtime-entry',
      title: 'Runtime Files',
      status: 'fail',
      message: err instanceof Error ? err.message : String(err),
      nextAction: 'Reinstall Gantry from npm, then run `gantry doctor` again.',
    });
  }

  try {
    ensureRuntimeWritable(runtimeHome);
    add(checks, {
      id: 'runtime-home',
      title: 'Runtime Home',
      status: 'pass',
      message: `Runtime home is writable: ${runtimeHome}`,
    });
  } catch (err) {
    add(checks, {
      id: 'runtime-home',
      title: 'Runtime Home',
      status: 'fail',
      message: `Cannot write to runtime home ${runtimeHome}.`,
      nextAction:
        err instanceof Error
          ? `Fix permissions or choose another runtime home. Details: ${err.message}`
          : 'Fix runtime-home permissions or choose a different path.',
    });
  }

  const ipcBaseDir = path.join(runtimeHome, 'data', 'ipc');
  try {
    fs.mkdirSync(ipcBaseDir, { recursive: true });
    add(checks, {
      id: 'ipc-layout',
      title: 'IPC Layout',
      status: 'pass',
      message:
        'IPC base directory is writable. Use `gantry status` for Postgres-backed group counts.',
    });
  } catch (err) {
    add(checks, {
      id: 'ipc-layout',
      title: 'IPC Layout',
      status: 'fail',
      message: `IPC layout is not writable at ${ipcBaseDir}.`,
      nextAction:
        err instanceof Error
          ? `Fix runtime-home permissions. Details: ${err.message}`
          : 'Fix runtime-home permissions and rerun doctor.',
    });
  }

  const envPath = envFilePath(runtimeHome);
  const env = readEnvFile(envPath);

  const settingsResult = loadSettingsForDoctor(runtimeHome);
  const settings = settingsResult.settings;
  const providers = listConnectableChannelProviders();
  const enabledProviders = settings
    ? providers.filter((provider) => settings.providers[provider.id]?.enabled)
    : [];
  if (settings) {
    if (enabledProviders.length > 0) {
      add(checks, {
        id: 'runtime-settings',
        title: 'Runtime Settings',
        status: 'pass',
        message: `Runtime settings loaded from ${path.join(runtimeHome, 'settings.yaml')} with canonical memory block.`,
      });
    } else {
      add(checks, {
        id: 'runtime-settings',
        title: 'Runtime Settings',
        status: 'fail',
        message:
          'Runtime settings are valid, but no providers are enabled in settings.yaml.',
        nextAction: `Run ${providers.map((provider) => `\`gantry provider connect ${provider.id}\``).join(' or ')} to enable a provider.`,
      });
    }
    const postgresUrlEnv = settings.storage.postgres.urlEnv;
    const postgresUrl =
      env[postgresUrlEnv]?.trim() || process.env[postgresUrlEnv]?.trim() || '';
    let storageStatus: DoctorStatus = 'pass';
    let storageMessage = `Postgres runtime storage is configured via ${postgresUrlEnv}.`;
    let storageNextAction: string | undefined;
    if (!postgresUrl) {
      storageStatus = 'fail';
      storageMessage = `${postgresUrlEnv} is missing.`;
      storageNextAction = `Set ${postgresUrlEnv} in ${envPath}.`;
    } else {
      try {
        validatePostgresConnectionUrl(postgresUrl, {
          allowLocalhost: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        storageStatus = 'fail';
        storageMessage = `${postgresUrlEnv} is invalid: ${message}`;
        storageNextAction = `Update ${postgresUrlEnv} in ${envPath}.`;
      }
    }

    add(checks, {
      id: 'runtime-storage',
      title: 'Runtime Storage',
      status: storageStatus,
      message: storageMessage,
      nextAction: storageNextAction,
    });
    if (storageStatus === 'fail') {
      add(checks, {
        id: 'local-postgres',
        title: 'Local Database',
        status: 'warn',
        message:
          'Use the provided docker-compose.yml, a locally installed Postgres, or hosted Postgres.',
        nextAction:
          'Start or provision Postgres yourself, then run `gantry setup` and paste the database URLs.',
      });
    }
    const onecliDatabaseUrlEnv =
      settings.credentialBroker.onecli.postgres.urlEnv;
    const credentialMode = settings.credentialBroker.mode;
    const onecliDatabaseUrl =
      env[onecliDatabaseUrlEnv]?.trim() ||
      process.env[onecliDatabaseUrlEnv]?.trim() ||
      '';
    const onecliSecret =
      env[ONECLI_SECRET_ENCRYPTION_KEY_ENV]?.trim() ||
      process.env[ONECLI_SECRET_ENCRYPTION_KEY_ENV]?.trim() ||
      '';
    let onecliPersistenceStatus: DoctorStatus = 'pass';
    let onecliPersistenceMessage = `OneCLI persistence is configured through ${onecliDatabaseUrlEnv}.`;
    let onecliPersistenceNextAction: string | undefined;
    if (credentialMode !== 'onecli') {
      onecliPersistenceStatus = 'pass';
      onecliPersistenceMessage = `OneCLI persistence is not required in ${credentialMode} credential mode.`;
    } else if (!onecliDatabaseUrl) {
      onecliPersistenceStatus = 'fail';
      onecliPersistenceMessage = `${onecliDatabaseUrlEnv} is missing.`;
      onecliPersistenceNextAction =
        'Run `gantry local setup`, or set it to the shared Postgres URL with schema=onecli.';
    } else {
      const validation = validateOnecliDatabaseUrl({
        postgresUrl: onecliDatabaseUrl,
        schema: settings.credentialBroker.onecli.postgres.schema,
      });
      if (!validation.ok) {
        onecliPersistenceStatus = 'fail';
        onecliPersistenceMessage = validation.message;
        onecliPersistenceNextAction = validation.nextAction;
      } else if (!onecliSecret) {
        onecliPersistenceStatus = 'fail';
        onecliPersistenceMessage =
          'SECRET_ENCRYPTION_KEY is missing for OneCLI broker persistence.';
        onecliPersistenceNextAction =
          'Generate a deployment secret and set SECRET_ENCRYPTION_KEY before starting OneCLI.';
      }
    }
    add(checks, {
      id: 'onecli-persistence-config',
      title: 'OneCLI Persistence Config',
      status: onecliPersistenceStatus,
      message: onecliPersistenceMessage,
      nextAction: onecliPersistenceNextAction,
    });
  } else {
    add(checks, {
      id: 'runtime-settings',
      title: 'Runtime Settings',
      status: 'fail',
      message: 'Runtime settings file is invalid.',
      nextAction: `Fix ${path.join(runtimeHome, 'settings.yaml')}. Details: ${settingsResult.error}`,
    });
  }
  const envViolations = validateRuntimeEnvPolicy(env).violations;
  const processViolations = validateRuntimeEnvPolicy(
    process.env,
    'process environment',
  ).violations;
  const allEnvPolicyViolations = envViolations.concat(processViolations);
  const runtimeEnvBoundaryNextActions = [
    envViolations.length
      ? 'Manually move wrong-lane Gantry .env values to settings.yaml or the selected credential broker.'
      : '',
    processViolations.length
      ? 'Unset wrong-lane keys from your shell or service environment.'
      : '',
    allEnvPolicyViolations.length
      ? 'Move non-secret settings to settings.yaml and agent credentials to Model Access or the selected credential broker.'
      : '',
  ].filter(Boolean);
  add(checks, {
    id: 'runtime-env-boundary',
    title: 'Runtime Env Boundary',
    status: allEnvPolicyViolations.length === 0 ? 'pass' : 'fail',
    message: allEnvPolicyViolations.length
      ? allEnvPolicyViolations.map((violation) => violation.message).join(' ')
      : '.env and process env contain runtime-owned secrets only.',
    nextAction: runtimeEnvBoundaryNextActions.length
      ? runtimeEnvBoundaryNextActions.join(' ')
      : undefined,
  });
  const onecliUrl = settings?.credentialBroker.onecli.url.trim() || '';
  const credentialMode = settings?.credentialBroker.mode || 'onecli';
  const externalBrokerUrl =
    settings?.credentialBroker.external.baseUrl.trim() || '';
  const externalBrokerValidation = externalBrokerUrl
    ? validateExternalBrokerUrl(
        externalBrokerUrl,
        'credential_broker.external.base_url',
      )
    : undefined;

  for (const provider of providers) {
    const enabled = settings?.providers[provider.id]?.enabled ?? false;
    const configuredKeys = provider.setup.envKeys.filter((envKey) =>
      Boolean(resolveRuntimeEnvValue(env, envKey)),
    );
    const missingKeys = provider.setup.envKeys.filter(
      (envKey) => !resolveRuntimeEnvValue(env, envKey),
    );
    const envCheckId =
      provider.id === 'telegram'
        ? 'telegram-token'
        : provider.id === 'slack'
          ? 'slack-tokens'
          : `${provider.id}-credentials`;
    const envCheckTitle =
      provider.id === 'telegram'
        ? 'Telegram Token'
        : provider.id === 'slack'
          ? 'Slack Tokens'
          : `${provider.label} Credentials`;

    if (!enabled) {
      add(checks, {
        id: envCheckId,
        title: envCheckTitle,
        status: 'pass',
        message: `${provider.label} channel is disabled in settings.yaml.`,
      });
    } else if (missingKeys.length === 0) {
      add(checks, {
        id: envCheckId,
        title: envCheckTitle,
        status: 'pass',
        message:
          provider.id === 'telegram'
            ? 'Telegram token is configured.'
            : provider.id === 'slack'
              ? 'Slack bot/app tokens are configured.'
              : `${provider.label} credentials are configured.`,
      });
    } else {
      const partialConfigured = configuredKeys.length > 0;
      add(checks, {
        id: envCheckId,
        title: envCheckTitle,
        status: 'warn',
        message:
          provider.id === 'telegram'
            ? `Telegram token is missing in ${envPath}.`
            : provider.id === 'slack' && partialConfigured
              ? 'Slack token setup is incomplete (both bot and app tokens are required).'
              : `${provider.label} credentials are missing in ${envPath}.`,
        nextAction: `Run \`gantry provider connect ${provider.id}\` to configure ${provider.label}.`,
      });
    }
  }

  const memoryHealth = inspectMemoryHealth(runtimeHome, settings, env);
  add(checks, {
    id: 'memory-provider',
    title: 'Memory Storage',
    status: memoryHealth.memoryCheck.status,
    message: memoryHealth.memoryCheck.message,
    nextAction: memoryHealth.memoryCheck.nextAction,
  });
  add(checks, {
    id: 'embeddings-provider',
    title: 'Memory Embeddings',
    status: memoryHealth.embeddingCheck.status,
    message: `${memoryHealth.embeddingProvider} (source: ${memoryHealth.embeddingProviderSource}): ${memoryHealth.embeddingCheck.message}`,
    nextAction: memoryHealth.embeddingCheck.nextAction,
  });
  let modelAccessStatus: DoctorStatus = 'pass';
  let modelAccessMessage = `Model Access is managed by ${credentialMode} credential mode.`;
  let modelAccessNextAction: string | undefined;
  if (credentialMode === 'external') {
    if (!externalBrokerUrl) {
      modelAccessStatus = 'fail';
      modelAccessMessage =
        'External credential mode requires credential_broker.external.base_url.';
      modelAccessNextAction =
        'Set credential_broker.external.base_url to the external credential broker endpoint, then rerun `gantry doctor`.';
    } else if (!externalBrokerValidation?.ok) {
      modelAccessStatus = 'fail';
      modelAccessMessage =
        externalBrokerValidation?.error ||
        'credential_broker.external.base_url is invalid.';
      modelAccessNextAction =
        'Set credential_broker.external.base_url to an HTTPS broker URL without embedded credentials, query parameters, or fragments.';
    }
  } else if (credentialMode === 'onecli') {
    const onecliUrlValidation = onecliUrl
      ? validateOnecliUrl(onecliUrl, 'credential_broker.onecli.url')
      : undefined;
    if (!onecliUrl) {
      modelAccessStatus = 'warn';
      modelAccessMessage =
        'Model Access is missing. Agent execution and memory LLM extraction require brokered model access.';
      modelAccessNextAction =
        'Run `gantry setup` and configure Model Access, then rerun `gantry doctor`.';
    } else if (!onecliUrlValidation?.ok) {
      modelAccessStatus = 'fail';
      modelAccessMessage =
        onecliUrlValidation?.error || 'Model Access URL is invalid.';
    } else {
      modelAccessMessage = `Model Access is configured at ${onecliUrl}.`;
    }
  }
  add(checks, {
    id: 'claude-broker',
    title: 'Model Access',
    status: modelAccessStatus,
    message: modelAccessMessage,
    nextAction: modelAccessNextAction,
  });

  const platform = detectPlatform();
  if (platform === 'linux') {
    add(checks, {
      id: 'service-manager',
      title: 'Service Manager',
      status: hasSystemdUser() ? 'pass' : 'warn',
      message: hasSystemdUser()
        ? 'systemd user session is available.'
        : 'systemd user session is not available. Background service will use a nohup fallback.',
      nextAction: hasSystemdUser()
        ? undefined
        : 'Use `gantry service install` to create the fallback start script.',
    });
  } else if (platform === 'windows') {
    add(checks, {
      id: 'service-manager',
      title: 'Service Manager',
      status: 'pass',
      message: 'Background service mode is available on Windows.',
      nextAction: 'Use `gantry service install` then `gantry service start`.',
    });
  } else if (platform === 'macos') {
    const hasLaunchctl = commandExists('launchctl');
    add(checks, {
      id: 'service-manager',
      title: 'Service Manager',
      status: hasLaunchctl ? 'pass' : 'warn',
      message: hasLaunchctl
        ? 'launchd is available.'
        : 'launchctl is unavailable in this shell session.',
      nextAction: hasLaunchctl
        ? 'Use `gantry service install` then `gantry service start`.'
        : 'Run from a normal macOS user session and retry.',
    });
  }

  const blockingFailures = checks.filter(
    (check) => check.status === 'fail',
  ).length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  return {
    ok: blockingFailures === 0,
    blockingFailures,
    warnings,
    checks,
  };
}

export async function runDoctorWithNetwork(
  importMetaUrl: string,
  runtimeHome: string,
  options: DoctorNetworkOptions = {},
): Promise<DoctorReport> {
  let report = runDoctor(importMetaUrl, runtimeHome);
  const validateTelegramToken = options.validateTelegramToken !== false;
  if (validateTelegramToken) {
    const telegramProvider = getProvider('telegram');
    if (telegramProvider) {
      const settings = loadSettingsForDoctor(runtimeHome).settings;
      if (settings?.providers[telegramProvider.id]?.enabled) {
        const env = readEnvFile(envFilePath(runtimeHome));
        const token = resolveRuntimeEnvValue(env, 'TELEGRAM_BOT_TOKEN');
        if (token) {
          const validation = await validateTelegramBotToken(
            token,
            options.telegramTimeoutMs,
          );
          if (validation.ok) {
            report = addToReport(report, {
              id: 'telegram-token-api',
              title: 'Telegram Token API Validation',
              status: 'pass',
              message: validation.message,
            });
          } else {
            report = addToReport(report, {
              id: 'telegram-token-api',
              title: 'Telegram Token API Validation',
              status: 'warn',
              message: validation.message,
              nextAction:
                validation.nextAction ||
                'Refresh TELEGRAM_BOT_TOKEN and rerun doctor.',
            });
          }
        }
      }
    }
  }

  const storageReadiness = await inspectRuntimeStorageReadiness(runtimeHome);
  report = addToReport(report, {
    id: 'storage-capabilities',
    title: 'Storage Capabilities',
    status: storageReadiness.status,
    message: storageReadiness.details?.length
      ? `${storageReadiness.message} ${storageReadiness.details.join(' | ')}`
      : storageReadiness.message,
    nextAction: storageReadiness.nextAction,
  });

  const settings = loadSettingsForDoctor(runtimeHome).settings;
  if (settings) {
    const env = readEnvFile(envFilePath(runtimeHome));
    const credentialMode = settings.credentialBroker.mode;
    if (credentialMode !== 'onecli') {
      return report;
    }
    const onecliUrl = settings.credentialBroker.onecli.url;
    const onecliDatabaseUrlEnv =
      settings.credentialBroker.onecli.postgres.urlEnv;
    const onecliDatabaseUrl = resolveRuntimeEnvValue(env, onecliDatabaseUrlEnv);
    const onecliSecret = resolveRuntimeEnvValue(
      env,
      ONECLI_SECRET_ENCRYPTION_KEY_ENV,
    );
    const onecliPersistence = await inspectOnecliPersistenceReadiness({
      postgresUrl: onecliDatabaseUrl,
      schema: settings.credentialBroker.onecli.postgres.schema,
      secretEncryptionKey: onecliSecret,
      gantryPostgresUrl: resolveRuntimeEnvValue(
        env,
        settings.storage.postgres.urlEnv,
      ),
      gantrySchema: settings.storage.postgres.schema,
    });
    report = addToReport(report, {
      id: 'onecli-persistence',
      title: 'OneCLI Persistence',
      status: onecliPersistence.status,
      message: onecliPersistence.details?.length
        ? `${onecliPersistence.message} ${onecliPersistence.details.join(' | ')}`
        : onecliPersistence.message,
      nextAction: onecliPersistence.nextAction,
    });

    const { OnecliAgentCredentialBroker } =
      await import('../adapters/credentials/onecli/broker.js');
    const broker = new OnecliAgentCredentialBroker({
      onecliUrl,
      dataDir: path.join(runtimeHome, 'data'),
      timeoutMs: ONECLI_DOCTOR_TIMEOUT_MS,
    });
    const health = await broker.healthCheck();
    report = addToReport(report, {
      id: 'onecli-reachability',
      title: 'OneCLI Reachability',
      status: health.status,
      message: health.details?.length
        ? `${health.message} ${health.details.join(' | ')}`
        : health.message,
      nextAction:
        health.nextAction ||
        (health.status === 'fail'
          ? 'Start Model Access with DATABASE_URL from ONECLI_DATABASE_URL and rerun `gantry doctor`.'
          : undefined),
    });
  }
  return report;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('Gantry Doctor Report');
  lines.push('');
  for (const check of report.checks) {
    lines.push(
      `[${statusLabel(check.status)}] ${check.title}: ${check.message}`,
    );
    if (check.nextAction) {
      lines.push(`  Next action: ${check.nextAction}`);
    }
  }
  lines.push('');
  lines.push(
    report.ok
      ? `Doctor finished with ${report.warnings} warning(s).`
      : `Doctor found ${report.blockingFailures} blocking issue(s) and ${report.warnings} warning(s).`,
  );
  return lines.join('\n');
}

export function hasRuntimeConfig(runtimeHome: string): boolean {
  try {
    const settings = ensureRuntimeSettings(runtimeHome);
    return listConnectableChannelProviders().some(
      (provider) => settings.providers[provider.id]?.enabled,
    );
  } catch {
    return false;
  }
}

export async function hasProcessableGroupForConfiguredChannel(
  runtimeHome: string,
): Promise<boolean> {
  let settings: RuntimeSettings;
  try {
    settings = ensureRuntimeSettings(runtimeHome);
  } catch {
    return false;
  }

  const env = readEnvFile(envFilePath(runtimeHome));

  for (const provider of listConnectableChannelProviders()) {
    if (!settings.providers[provider.id]?.enabled) continue;
    const hasRequiredCredentials = provider.setup.envKeys.every((envKey) =>
      Boolean(resolveRuntimeEnvValue(env, envKey)),
    );
    if (!hasRequiredCredentials) continue;
    let db: Awaited<ReturnType<typeof openRuntimeGroupDb>> | undefined;
    try {
      db = await openRuntimeGroupDb(runtimeHome, { migrate: false });
      const count = await db.countConversationRoutesByJidPrefix(
        provider.jidPrefix,
      );
      if (count > 0) return true;
    } catch {
      continue;
    } finally {
      await db?.close();
    }
  }

  return false;
}
