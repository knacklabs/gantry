import { nowMs } from '../../shared/time/datetime.js';

export const BROWSER_ACTION_TIMEOUT_MS = 30_000;

const MIN_BROWSER_ACTION_TIMEOUT_MS = 1_000;
const MAX_BROWSER_ACTION_TIMEOUT_MS = 120_000;

class BrowserRequestTimeoutError extends Error {}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new BrowserRequestTimeoutError(message)),
      timeoutMs,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function browserActionTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return BROWSER_ACTION_TIMEOUT_MS;
  }
  return Math.max(
    MIN_BROWSER_ACTION_TIMEOUT_MS,
    Math.min(MAX_BROWSER_ACTION_TIMEOUT_MS, Math.trunc(value)),
  );
}

export function remainingBrowserActionTimeoutMs(deadline: number): number {
  const remaining = deadline - nowMs();
  if (remaining <= 0) {
    throw new BrowserRequestTimeoutError('Browser action timed out.');
  }
  return Math.max(1, Math.trunc(remaining));
}

export function actionOperationTimeout(deadline: number): number {
  return Math.min(
    MAX_BROWSER_ACTION_TIMEOUT_MS,
    remainingBrowserActionTimeoutMs(deadline),
  );
}
