import type { RuntimeLeasePort } from './runtime-lease.js';

const SETTINGS_PROJECTOR_LEASE_RETRY_MS = 50;
const SETTINGS_PROJECTOR_LEASE_WAIT_MS = 30_000;

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
