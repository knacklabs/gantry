import type { RuntimeLeasePort } from './runtime-lease.js';

const SETTINGS_PROJECTOR_LEASE_RETRY_MS = 50;
const SETTINGS_PROJECTOR_LEASE_WAIT_MS = 30_000;

export type SettingsProjectorLeaseAttempt<T> =
  | { acquired: true; value: T }
  | { acquired: false };

/**
 * Attempt the projector lease once. Fleet startup uses this during a rolling
 * deployment: the retiring runtime may legitimately own the lease until ECS
 * considers its replacement healthy. The replacement can safely consume the
 * durable revision while that owner remains responsible for projection.
 */
export async function tryWithSettingsProjectorLease<T>(
  leases: RuntimeLeasePort,
  appId: string,
  fn: () => Promise<T> | T,
): Promise<SettingsProjectorLeaseAttempt<T>> {
  const lease = await leases.tryAcquire(`settings-projector:${appId}`);
  if (!lease) return { acquired: false };
  try {
    return { acquired: true, value: await fn() };
  } finally {
    await lease.release();
  }
}

export async function withSettingsProjectorLease<T>(
  leases: RuntimeLeasePort,
  appId: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const key = `settings-projector:${appId}`;
  const deadline = Date.now() + SETTINGS_PROJECTOR_LEASE_WAIT_MS;
  let lease = await leases.tryAcquire(key);
  while (!lease && Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(SETTINGS_PROJECTOR_LEASE_RETRY_MS, deadline - Date.now()),
      ),
    );
    lease = await leases.tryAcquire(key);
  }
  if (!lease) {
    throw new Error(
      `Timed out waiting for settings projector lease for app ${appId}`,
    );
  }
  try {
    return await fn();
  } finally {
    await lease.release();
  }
}
