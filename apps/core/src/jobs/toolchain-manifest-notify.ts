import type { Pool } from 'pg';

import type { RuntimeDependency } from '../domain/ports/fleet-capability-state.js';
import type { ToolchainBakeNotifier } from './toolchain-bake-executor.js';

/**
 * pg_notify channel the bake publishes to and worker reconcilers LISTEN on.
 * Carried as a plain literal so publisher and listener cannot drift.
 */
export const TOOLCHAIN_MANIFEST_CHANNEL = 'gantry_runtime_dependencies';

export interface ToolchainManifestWakeup {
  appId: string;
  manifestHash: string;
  status: RuntimeDependency['status'];
}

export function parseToolchainManifestWakeup(
  payload: string | undefined,
): ToolchainManifestWakeup | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Partial<ToolchainManifestWakeup>;
    if (
      typeof parsed.appId !== 'string' ||
      typeof parsed.manifestHash !== 'string' ||
      typeof parsed.status !== 'string'
    ) {
      return null;
    }
    return {
      appId: parsed.appId,
      manifestHash: parsed.manifestHash,
      status: parsed.status as RuntimeDependency['status'],
    };
  } catch {
    return null;
  }
}

/**
 * Pool-backed manifest notifier. A failed NOTIFY is logged, not thrown: the
 * reconciler's interval poll fallback recovers a dropped wakeup, so the bake
 * lifecycle is not blocked on notification delivery.
 */
export class PostgresToolchainManifestNotifier implements ToolchainBakeNotifier {
  constructor(
    private readonly pool: Pool,
    private readonly logWarn?: (
      context: Record<string, unknown>,
      message: string,
    ) => void,
  ) {}

  async notifyManifestChanged(input: ToolchainManifestWakeup): Promise<void> {
    const payload = JSON.stringify({
      appId: input.appId,
      manifestHash: input.manifestHash,
      status: input.status,
    });
    try {
      await this.pool.query('SELECT pg_notify($1, $2)', [
        TOOLCHAIN_MANIFEST_CHANNEL,
        payload,
      ]);
    } catch (err) {
      this.logWarn?.(
        { err, appId: input.appId, manifestHash: input.manifestHash },
        'Failed to publish toolchain manifest wakeup; reconcilers recover by poll',
      );
    }
  }
}
