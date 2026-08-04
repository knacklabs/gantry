import { readEnvFile } from './env/file.js';
import { validateProductionSecurityGate } from '../shared/security-posture.js';
import { ensureRuntimeLayout, envFilePath } from './settings/runtime-home.js';
import {
  ensureRuntimeSettings,
  validateRuntimeSettings,
} from './settings/runtime-settings.js';
import {
  inspectRuntimeSecretReadiness,
  inspectRuntimeStorageReadiness,
} from '../adapters/storage/postgres/storage-readiness.js';

export interface RuntimePreflightFailure {
  summary: string;
  details: string[];
}

export interface RuntimePreflightResult {
  ok: boolean;
  failure?: RuntimePreflightFailure;
}

export function validateRuntimePreflight(
  runtimeHome: string,
): RuntimePreflightResult {
  ensureRuntimeLayout(runtimeHome);
  const settingsValidation = validateRuntimeSettings(runtimeHome);
  if (!settingsValidation.ok && settingsValidation.failure) {
    return {
      ok: false,
      failure: settingsValidation.failure,
    };
  }
  const settings = settingsValidation.settings;
  if (!settings) {
    return {
      ok: false,
      failure: {
        summary: 'Runtime settings validation failed.',
        details: ['Runtime settings were not available after validation.'],
      },
    };
  }

  const productionFailures = validateProductionSecurityGate({
    env: runtimePreflightEnv(runtimeHome),
    sandboxProvider: settings.runtime.sandbox.provider,
  });
  if (productionFailures.length > 0) {
    return {
      ok: false,
      failure: {
        summary: 'Production security preflight failed.',
        details: productionFailures,
      },
    };
  }

  return { ok: true };
}

function runtimePreflightEnv(runtimeHome: string): NodeJS.ProcessEnv {
  const env = { ...readEnvFile(envFilePath(runtimeHome)) };
  for (const [key, value] of Object.entries(process.env)) {
    const trimmed = value?.trim();
    if (trimmed) env[key] = trimmed;
  }
  return env;
}

export async function validateRuntimePreflightWithStorage(
  runtimeHome: string,
): Promise<RuntimePreflightResult> {
  ensureRuntimeLayout(runtimeHome);
  const base = validateRuntimePreflight(runtimeHome);
  if (!base.ok) {
    return base;
  }

  const storageReadiness = await inspectRuntimeStorageReadiness(runtimeHome);
  if (storageReadiness.status === 'fail') {
    return {
      ok: false,
      failure: {
        summary: storageReadiness.message,
        details: [
          ...(storageReadiness.details || []),
          ...(storageReadiness.nextAction
            ? [`Next action: ${storageReadiness.nextAction}`]
            : []),
        ],
      },
    };
  }

  ensureRuntimeSettings(runtimeHome);
  const settings = ensureRuntimeSettings(runtimeHome);
  const secretReadiness = await inspectRuntimeSecretReadiness(
    runtimeHome,
    settings,
  );
  if (secretReadiness.status === 'fail') {
    return {
      ok: false,
      failure: {
        summary: secretReadiness.message,
        details: secretReadiness.details || [],
      },
    };
  }
  readEnvFile(envFilePath(runtimeHome));
  return { ok: true };
}

export function formatRuntimePreflightFailure(
  failure: RuntimePreflightFailure,
): string {
  return [failure.summary, ...failure.details.map((line) => `- ${line}`)].join(
    '\n',
  );
}
