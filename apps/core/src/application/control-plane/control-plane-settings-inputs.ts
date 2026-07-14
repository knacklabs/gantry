import type {
  ControlPlaneMemoryStatus,
  ControlPlaneProviderInput,
} from './control-plane-read-model.js';

/**
 * Minimal structural view of runtime settings needed to derive control-plane
 * provider/memory inputs. Both the redacted Control API settings and the full
 * RuntimeSettings satisfy this, so every surface shares one derivation.
 */
export interface ControlPlaneSettingsInputView {
  providers?: Record<string, { enabled?: boolean } | undefined>;
  providerAccounts?: Record<string, { provider: string }>;
}

export function controlPlaneProviderInputs(
  settings: ControlPlaneSettingsInputView,
): ControlPlaneProviderInput[] {
  const accountProviders = new Set(
    Object.values(settings.providerAccounts ?? {}).map(
      (account) => account.provider,
    ),
  );
  const providerIds = new Set([
    ...Object.keys(settings.providers ?? {}),
    ...accountProviders,
  ]);
  return [...providerIds]
    .filter(
      (id) =>
        settings.providers?.[id]?.enabled === true || accountProviders.has(id),
    )
    .map((id) => ({
      id,
      label: id,
      ready:
        (settings.providers?.[id]?.enabled === true ||
          settings.providers?.[id] === undefined) &&
        accountProviders.has(id),
    }));
}

export function controlPlaneMemoryStatus(
  enabled: boolean,
): ControlPlaneMemoryStatus {
  return enabled ? 'Ready' : 'Disabled';
}

export function controlPlaneJobStatus(
  status: string | undefined,
): 'ready' | 'needs_action' | 'blocked' {
  if (status === 'dead_lettered') return 'blocked';
  if (status === 'paused') return 'needs_action';
  return 'ready';
}
