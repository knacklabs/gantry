import { ensureRuntimeLayout } from './runtime-home.js';
import { validateRuntimeSettings } from './runtime-settings.js';

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

  return { ok: true };
}

export function formatRuntimePreflightFailure(
  failure: RuntimePreflightFailure,
): string {
  return [failure.summary, ...failure.details.map((line) => `- ${line}`)].join(
    '\n',
  );
}
