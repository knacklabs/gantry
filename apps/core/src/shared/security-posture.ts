import { parseControlApiKeysStrict } from './control-api-keys.js';
import { isStrongProductionSecret } from './secret-strength.js';

export interface RuntimeSecurityEnv {
  NODE_ENV?: string;
  GANTRY_RUNTIME_ENV?: string;
  GANTRY_SECURITY_POSTURE?: string;
  GANTRY_CONTROL_HOST?: string;
  GANTRY_CONTROL_PORT?: string;
  GANTRY_CONTROL_API_KEYS_JSON?: string;
  GANTRY_IPC_AUTH_SECRET?: string;
  REMOTE_CONTROL_AUTO_ACCEPT?: string;
  SECRET_ENCRYPTION_KEY?: string;
  SECRET_ENCRYPTION_KEYRING_JSON?: string;
}

export interface RuntimeSecurityPosture {
  production: boolean;
  remoteControl: boolean;
  requiresProductionSecrets: boolean;
  requiresEnforcingSandbox: boolean;
}

const LOCAL_CONTROL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLocalControlHost(host: string | undefined): boolean {
  const normalized = (host || '127.0.0.1').trim().toLowerCase();
  return LOCAL_CONTROL_HOSTS.has(normalized);
}

export function resolveRuntimeSecurityPosture(
  env: RuntimeSecurityEnv,
): RuntimeSecurityPosture {
  const securityPosture =
    env.GANTRY_SECURITY_POSTURE?.trim().toLowerCase() || '';
  const runtimeEnv = env.GANTRY_RUNTIME_ENV?.trim().toLowerCase() || '';
  const production =
    env.NODE_ENV?.trim().toLowerCase() === 'production' ||
    securityPosture === 'production' ||
    runtimeEnv === 'production';
  const remoteDeployment =
    securityPosture === 'remote' || runtimeEnv === 'remote';
  const port = Number(env.GANTRY_CONTROL_PORT?.trim() || 0);
  const remoteControl =
    port > 0 && !isLocalControlHost(env.GANTRY_CONTROL_HOST);
  return {
    production,
    remoteControl,
    requiresProductionSecrets: production || remoteControl || remoteDeployment,
    // Two-axis model (decision 0040): the user chooses the sandbox provider;
    // Gantry does NOT force `sandbox_runtime` in production/remote. Authorization
    // (permission engine + classifier + credential rail) is the control; the OS
    // jail is opt-in. Kept as a field (a control-server consumer reads it) but no
    // longer mandates confinement.
    requiresEnforcingSandbox: false,
  };
}

export function validateProductionSecurityGate(input: {
  env: RuntimeSecurityEnv;
  sandboxProvider?: 'direct' | 'sandbox_runtime';
}): string[] {
  const env = input.env;
  const posture = resolveRuntimeSecurityPosture(env);
  if (!posture.requiresProductionSecrets) return [];

  const failures: string[] = [];
  if (
    posture.requiresEnforcingSandbox &&
    input.sandboxProvider !== 'sandbox_runtime'
  ) {
    failures.push(
      'runtime.sandbox.provider must be sandbox_runtime in production or remote control mode.',
    );
  }
  if (!hasValidEncryptionSecret(env)) {
    failures.push(
      'SECRET_ENCRYPTION_KEY or SECRET_ENCRYPTION_KEYRING_JSON must provide a strong base64-encoded 32-byte active key.',
    );
  }
  if (!env.GANTRY_IPC_AUTH_SECRET?.trim()) {
    failures.push('GANTRY_IPC_AUTH_SECRET is required.');
  } else if (!isStrongProductionSecret(env.GANTRY_IPC_AUTH_SECRET)) {
    failures.push(
      'GANTRY_IPC_AUTH_SECRET must be at least 32 characters of non-trivial secret material in production or remote control mode.',
    );
  }
  if (isEnabledEnvFlag(env.REMOTE_CONTROL_AUTO_ACCEPT)) {
    failures.push(
      'REMOTE_CONTROL_AUTO_ACCEPT is local-development-only and cannot be enabled in production or remote control mode.',
    );
  }
  try {
    const keys = parseControlApiKeysStrict({
      rawJson: env.GANTRY_CONTROL_API_KEYS_JSON,
      requireStrongTokens: true,
      requireNonEmptyScopes: true,
    });
    if (posture.requiresProductionSecrets && keys.length === 0) {
      failures.push(
        'GANTRY_CONTROL_API_KEYS_JSON must include at least one valid control API key.',
      );
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  return failures;
}

export function hasValidEncryptionSecret(env: RuntimeSecurityEnv): boolean {
  const keyring = env.SECRET_ENCRYPTION_KEYRING_JSON?.trim();
  if (keyring) return hasValidEncryptionKeyring(keyring);
  const direct = env.SECRET_ENCRYPTION_KEY?.trim();
  return Boolean(direct && isStrongBase64Encoded32ByteSecret(direct));
}

function hasValidEncryptionKeyring(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as {
      active?: unknown;
      keys?: unknown;
    };
    const active = typeof parsed.active === 'string' ? parsed.active : '';
    if (
      !active.trim() ||
      !parsed.keys ||
      typeof parsed.keys !== 'object' ||
      Array.isArray(parsed.keys)
    ) {
      return false;
    }
    let activeFound = false;
    for (const [keyId, value] of Object.entries(
      parsed.keys as Record<string, unknown>,
    )) {
      if (!keyId.trim() || typeof value !== 'string') return false;
      if (!isStrongBase64Encoded32ByteSecret(value)) return false;
      if (keyId === active) activeFound = true;
    }
    return activeFound;
  } catch {
    return false;
  }
}

function isStrongBase64Encoded32ByteSecret(value: string): boolean {
  try {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== 32) return false;
    return new Set(bytes).size >= 16;
  } catch {
    return false;
  }
}

function isEnabledEnvFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() || '';
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}
