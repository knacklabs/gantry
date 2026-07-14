import fs from 'fs';
import path from 'path';
import '../channels/register-builtins.js';
import { listConnectableChannelProviders } from '../channels/provider-registry.js';
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
  type RuntimeSettings,
} from '../config/settings/runtime-settings.js';
import { inspectMemoryHealth } from './memory-health.js';
import {
  fleetRehearsalPlaintextPostgresHosts,
  validatePostgresConnectionUrl,
} from '../adapters/storage/postgres/url.js';
import { inspectRuntimeStorageReadiness } from '../adapters/storage/postgres/storage-readiness.js';
import { validateRuntimeEnvPolicy } from '../config/source-classification.js';
import { inspectModelCredentialReadiness } from './model-credential-readiness.js';
import type { GuidedActionRef } from '../application/guided-actions/guided-action-model.js';
import { inspectRunnerSandbox } from './doctor-runner-sandbox.js';
import { hasValidEncryptionSecret } from '../shared/security-posture.js';
import {
  hasRuntimeCredentialConfigured,
  resolveRuntimeEnvValue,
} from './runtime-credential-check.js';
import { collectUnresolvedRuntimeSecretProviderIds } from './runtime-secret-status.js';
import {
  inspectSlackTokenLiveCheck,
  inspectTelegramTokenLiveCheck,
} from './model-credential-verify.js';
import { openRuntimeGroupDb } from './runtime-group-db.js';
import {
  hasConfiguredChannelProvider,
  hasProcessableGroupForConfiguredChannelSettings,
} from './doctor-runtime-config.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorStatus;
  message: string;
  nextAction?: string;
  action?: GuidedActionRef;
}

export type DoctorReport = {
  ok: boolean;
  blockingFailures: number;
  warnings: number;
  checks: DoctorCheck[];
};

export type DoctorNetworkOptions = {
  validateTelegramToken?: boolean;
  validateSlackToken?: boolean;
  validateModelCredentials?: boolean;
  modelCredentialLiveSkipProviderIds?: readonly string[];
  telegramTimeoutMs?: number;
  slackTimeoutMs?: number;
};

type DoctorRuntimeSecretOptions = {
  unresolvedRuntimeSecretProviderIds?: Set<string>;
};

export function hasRuntimeConfig(runtimeHome: string): boolean {
  try {
    return hasConfiguredChannelProvider(ensureRuntimeSettings(runtimeHome));
  } catch {
    return false;
  }
}

export async function hasProcessableGroupForConfiguredChannel(
  runtimeHome: string,
): Promise<boolean> {
  let settings: ReturnType<typeof ensureRuntimeSettings>;
  try {
    settings = ensureRuntimeSettings(runtimeHome);
  } catch {
    return false;
  }

  const env = readEnvFile(envFilePath(runtimeHome));
  return hasProcessableGroupForConfiguredChannelSettings({
    runtimeHome,
    settings,
    env,
    openRuntimeGroupDb,
  });
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

function channelTokenRestartNextAction(providerId: string): string | undefined {
  if (providerId !== 'slack' && providerId !== 'telegram') return undefined;
  return `re-run \`gantry provider connect ${providerId}\`, then \`gantry restart\``;
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
  runtimeSecretOptions: DoctorRuntimeSecretOptions = {},
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
      action: {
        type: 'run_verification',
        label: 'Install Node.js 24 or 25 and run `gantry doctor` again.',
      },
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
      action: {
        type: 'run_verification',
        label: 'Reinstall Gantry from npm, then run `gantry doctor` again.',
      },
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
    const runtimeHomeNextAction =
      err instanceof Error
        ? `Fix permissions or choose another runtime home. Details: ${err.message}`
        : 'Fix runtime-home permissions or choose a different path.';
    add(checks, {
      id: 'runtime-home',
      title: 'Runtime Home',
      status: 'fail',
      message: `Cannot write to runtime home ${runtimeHome}.`,
      nextAction: runtimeHomeNextAction,
      action: {
        type: 'run_verification',
        label: runtimeHomeNextAction,
      },
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
    const ipcLayoutNextAction =
      err instanceof Error
        ? `Fix runtime-home permissions. Details: ${err.message}`
        : 'Fix runtime-home permissions and rerun doctor.';
    add(checks, {
      id: 'ipc-layout',
      title: 'IPC Layout',
      status: 'fail',
      message: `IPC layout is not writable at ${ipcBaseDir}.`,
      nextAction: ipcLayoutNextAction,
      action: {
        type: 'run_verification',
        label: ipcLayoutNextAction,
      },
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
        action: {
          type: 'connect_provider',
          label: `Run ${providers.map((provider) => `\`gantry provider connect ${provider.id}\``).join(' or ')} to enable a provider.`,
        },
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
          plaintextHostAllowlist: fleetRehearsalPlaintextPostgresHosts({
            ...env,
            ...process.env,
          }),
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
      action: storageNextAction
        ? { type: 'run_verification', label: storageNextAction }
        : undefined,
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
        action: {
          type: 'run_verification',
          label:
            'Start or provision Postgres yourself, then run `gantry setup` and paste the database URLs.',
        },
      });
    }
    const credentialMode = settings.credentialBroker.mode;
    const modelCredentialSecretValid = hasValidEncryptionSecret({
      SECRET_ENCRYPTION_KEY: resolveRuntimeEnvValue(
        env,
        'SECRET_ENCRYPTION_KEY',
      ),
      SECRET_ENCRYPTION_KEYRING_JSON: resolveRuntimeEnvValue(
        env,
        'SECRET_ENCRYPTION_KEYRING_JSON',
      ),
    });
    const modelCredentialNextAction =
      credentialMode === 'gantry' && !modelCredentialSecretValid
        ? 'Configure a strong base64-encoded 32-byte SECRET_ENCRYPTION_KEY or SECRET_ENCRYPTION_KEYRING_JSON, then restart Gantry.'
        : undefined;
    add(checks, {
      id: 'model-credential-encryption',
      title: 'Model Credential Encryption',
      status:
        credentialMode === 'gantry' && !modelCredentialSecretValid
          ? 'fail'
          : 'pass',
      message:
        credentialMode === 'gantry'
          ? modelCredentialSecretValid
            ? 'SECRET_ENCRYPTION_KEY or SECRET_ENCRYPTION_KEYRING_JSON is configured for Gantry credential encryption.'
            : 'SECRET_ENCRYPTION_KEY or SECRET_ENCRYPTION_KEYRING_JSON is missing or invalid for Gantry credential encryption.'
          : 'Model credential encryption is not required when model_access is disabled.',
      nextAction: modelCredentialNextAction,
      action: modelCredentialNextAction
        ? { type: 'connect_provider', label: modelCredentialNextAction }
        : undefined,
    });
  } else {
    add(checks, {
      id: 'runtime-settings',
      title: 'Runtime Settings',
      status: 'fail',
      message: 'Runtime settings file is invalid.',
      nextAction: `Fix ${path.join(runtimeHome, 'settings.yaml')}. Details: ${settingsResult.error}`,
      action: {
        type: 'run_verification',
        label: `Fix ${path.join(runtimeHome, 'settings.yaml')}. Details: ${settingsResult.error}`,
      },
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
      ? 'Manually move wrong-lane Gantry .env values to settings.yaml or Gantry Credential Center.'
      : '',
    processViolations.length
      ? 'Unset wrong-lane keys from your shell or service environment.'
      : '',
    allEnvPolicyViolations.length
      ? 'Move non-secret settings to settings.yaml and model provider keys to `gantry credentials model set`.'
      : '',
  ].filter(Boolean);
  const runtimeEnvBoundaryNextAction = runtimeEnvBoundaryNextActions.length
    ? runtimeEnvBoundaryNextActions.join(' ')
    : undefined;
  add(checks, {
    id: 'runtime-env-boundary',
    title: 'Runtime Env Boundary',
    status: allEnvPolicyViolations.length === 0 ? 'pass' : 'fail',
    message: allEnvPolicyViolations.length
      ? allEnvPolicyViolations.map((violation) => violation.message).join(' ')
      : '.env and process env contain runtime-owned secrets only.',
    nextAction: runtimeEnvBoundaryNextAction,
    action: runtimeEnvBoundaryNextAction
      ? { type: 'run_verification', label: runtimeEnvBoundaryNextAction }
      : undefined,
  });
  const sandboxCheck = inspectRunnerSandbox(settings);
  if (sandboxCheck) add(checks, sandboxCheck);
  const credentialMode = settings?.credentialBroker.mode || 'gantry';
  const unresolvedRuntimeSecretProviderIds =
    runtimeSecretOptions.unresolvedRuntimeSecretProviderIds;

  for (const provider of providers) {
    const enabled = settings?.providers[provider.id]?.enabled ?? false;
    const credentialConfigured = (envKey: string) =>
      hasRuntimeCredentialConfigured({
        settings,
        env,
        providerId: provider.id,
        envKey,
        unresolvedRuntimeSecretProviderIds,
      });
    const configuredKeys = provider.setup.envKeys.filter(credentialConfigured);
    const missingKeys = provider.setup.envKeys.filter(
      (envKey) => !credentialConfigured(envKey),
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
            ? 'Telegram token reference is configured.'
            : provider.id === 'slack'
              ? 'Slack bot/app token references are configured.'
              : `${provider.label} credential references are configured.`,
      });
    } else {
      const partialConfigured = configuredKeys.length > 0;
      const nextAction =
        (unresolvedRuntimeSecretProviderIds?.has(provider.id)
          ? channelTokenRestartNextAction(provider.id)
          : undefined) ??
        `Run \`gantry provider connect ${provider.id}\` to configure ${provider.label}.`;
      add(checks, {
        id: envCheckId,
        title: envCheckTitle,
        status: 'warn',
        message:
          provider.id === 'telegram'
            ? 'Telegram token reference is missing.'
            : provider.id === 'slack' && partialConfigured
              ? 'Slack token setup is incomplete (both bot and app tokens are required).'
              : `${provider.label} credential references are missing.`,
        nextAction,
        action: {
          type: 'connect_provider',
          label: nextAction,
        },
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
    action: memoryHealth.memoryCheck.nextAction
      ? { type: 'review_memory', label: memoryHealth.memoryCheck.nextAction }
      : undefined,
  });
  add(checks, {
    id: 'embeddings-provider',
    title: 'Memory Embeddings',
    status: memoryHealth.embeddingCheck.status,
    message: `${memoryHealth.embeddingProvider} (source: ${memoryHealth.embeddingProviderSource}): ${memoryHealth.embeddingCheck.message}`,
    nextAction: memoryHealth.embeddingCheck.nextAction,
    action: memoryHealth.embeddingCheck.nextAction
      ? { type: 'review_memory', label: memoryHealth.embeddingCheck.nextAction }
      : undefined,
  });
  const modelAccessStatus: DoctorStatus =
    credentialMode === 'gantry' ? 'pass' : 'warn';
  const modelAccessMessage =
    credentialMode === 'gantry'
      ? 'Gantry Model Gateway config is enabled; provider credential readiness is checked separately.'
      : 'Model Access is disabled. Agent execution and memory LLM extraction require Gantry Model Gateway credentials.';
  let modelAccessNextAction: string | undefined;
  if (credentialMode !== 'gantry') {
    modelAccessNextAction =
      'Set model_access.enabled to true and add model credentials before running agents.';
  }
  add(checks, {
    id: 'claude-broker',
    title: 'Model Access',
    status: modelAccessStatus,
    message: modelAccessMessage,
    nextAction: modelAccessNextAction,
    action: modelAccessNextAction
      ? { type: 'connect_provider', label: modelAccessNextAction }
      : undefined,
  });

  const platform = detectPlatform();
  if (platform === 'linux') {
    const linuxServiceNextAction = hasSystemdUser()
      ? undefined
      : 'Use `gantry service install` to create the fallback start script.';
    add(checks, {
      id: 'service-manager',
      title: 'Service Manager',
      status: hasSystemdUser() ? 'pass' : 'warn',
      message: hasSystemdUser()
        ? 'systemd user session is available.'
        : 'systemd user session is not available. Background service will use a nohup fallback.',
      nextAction: linuxServiceNextAction,
      action: linuxServiceNextAction
        ? { type: 'run_verification', label: linuxServiceNextAction }
        : undefined,
    });
  } else if (platform === 'windows') {
    add(checks, {
      id: 'service-manager',
      title: 'Service Manager',
      status: 'pass',
      message: 'Background service mode is available on Windows.',
      nextAction: 'Use `gantry service install` then `gantry service start`.',
      action: {
        type: 'run_verification',
        label: 'Use `gantry service install` then `gantry service start`.',
      },
    });
  } else if (platform === 'macos') {
    const hasLaunchctl = commandExists('launchctl');
    const macServiceNextAction = hasLaunchctl
      ? 'Use `gantry service install` then `gantry service start`.'
      : 'Run from a normal macOS user session and retry.';
    add(checks, {
      id: 'service-manager',
      title: 'Service Manager',
      status: hasLaunchctl ? 'pass' : 'warn',
      message: hasLaunchctl
        ? 'launchd is available.'
        : 'launchctl is unavailable in this shell session.',
      nextAction: macServiceNextAction,
      action: {
        type: 'run_verification',
        label: macServiceNextAction,
      },
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
  const settings = loadSettingsForDoctor(runtimeHome).settings;
  const unresolvedRuntimeSecretProviderIds = settings
    ? await collectUnresolvedRuntimeSecretProviderIds(runtimeHome, settings)
    : undefined;
  let report = runDoctor(importMetaUrl, runtimeHome, {
    unresolvedRuntimeSecretProviderIds,
  });
  const validateTelegramToken = options.validateTelegramToken !== false;
  const validateSlackToken = options.validateSlackToken !== false;
  const env = readEnvFile(envFilePath(runtimeHome));
  if (validateTelegramToken) {
    const telegramCheck = settings
      ? await inspectTelegramTokenLiveCheck({
          settings,
          env,
          timeoutMs: options.telegramTimeoutMs,
        })
      : null;
    if (telegramCheck) report = addToReport(report, telegramCheck);
  }
  if (validateSlackToken) {
    const slackCheck = settings
      ? await inspectSlackTokenLiveCheck({
          settings,
          env,
          timeoutMs: options.slackTimeoutMs,
        })
      : null;
    if (slackCheck) report = addToReport(report, slackCheck);
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
    action: storageReadiness.nextAction
      ? { type: 'run_verification', label: storageReadiness.nextAction }
      : undefined,
  });

  if (settings) {
    report = addToReport(
      report,
      await inspectModelCredentialReadiness(runtimeHome, settings, {
        live: options.validateModelCredentials !== false,
        skipLiveProviderIds: options.modelCredentialLiveSkipProviderIds,
      }),
    );
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
