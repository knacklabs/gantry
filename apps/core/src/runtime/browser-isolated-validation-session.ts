import { randomUUID } from 'node:crypto';

import type { BrowserContext, Page } from 'playwright-core';

import {
  getBrowserConnection,
  observePage,
  scheduleConnectionIdleClose,
} from '../adapters/browser/browser-direct-session.js';
import {
  remainingBrowserActionTimeoutMs,
  withTimeout,
} from '../adapters/browser/browser-direct-timeout.js';
import { nowMs } from '../shared/time/datetime.js';
import { installBrowserContextNetworkPolicy } from './browser-network-policy.js';

export interface IsolatedValidationBrowserSession {
  readonly id: string;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly deadlineAtMs: number;
  readonly networkEvidence: () => {
    readonly failures: readonly {
      readonly origin: string;
      readonly resourceType: string;
      readonly code: 'browser_method_not_approved';
      readonly method: string;
    }[];
  };
}

export async function withIsolatedValidationBrowserSession<T>(input: {
  readonly profileName: string;
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly allowedMethodsByOrigin?: Readonly<Record<string, readonly string[]>>;
  readonly timeoutMs: number;
  readonly execute: (session: IsolatedValidationBrowserSession) => Promise<T>;
}): Promise<T> {
  const allowedOrigins = validationAllowedOrigins(input.allowedOrigins);
  const deadlineAtMs = nowMs() + Math.max(1, Math.trunc(input.timeoutMs));
  const cdpEndpoint = `http://127.0.0.1:${input.port}`;
  const key = `recipe-validation\0${input.profileName}\0${cdpEndpoint}`;
  const connection = await getBrowserConnection({
    key,
    cdpEndpoint,
    deadline: deadlineAtMs,
    remainingMs: remainingBrowserActionTimeoutMs,
    withTimeout,
  });
  let context: BrowserContext | undefined;
  const failures: Array<{
    origin: string;
    resourceType: string;
    code: 'browser_method_not_approved';
    method: string;
  }> = [];
  try {
    context = await connection.browser.newContext({
      acceptDownloads: true,
      serviceWorkers: 'block',
    });
    await installBrowserContextNetworkPolicy({
      context,
      allowedHosts: [],
      allowedOrigins,
      allowedMethodsByOrigin: input.allowedMethodsByOrigin,
      onRequestDenied: (denial) => {
        failures.push({
          origin: denial.origin,
          resourceType: denial.resourceType,
          code: 'browser_method_not_approved',
          method: denial.method,
        });
        if (failures.length > 20) failures.splice(0, failures.length - 20);
      },
    });
    const page = await context.newPage();
    observePage(page);
    return await withTimeout(
      input.execute({
        id: randomUUID(),
        context,
        page,
        deadlineAtMs,
        networkEvidence: () => ({
          failures: failures.map((failure) => ({ ...failure })),
        }),
      }),
      remainingBrowserActionTimeoutMs(deadlineAtMs),
      'Recipe validation browser session timed out.',
    );
  } finally {
    await context?.close().catch(() => undefined);
    scheduleConnectionIdleClose(key);
  }
}

export function validationAllowedOrigins(
  allowedOrigins: readonly string[],
): readonly string[] {
  const hosts = new Set<string>();
  for (const origin of allowedOrigins) {
    const url = new URL(origin.trim());
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error(`Invalid validation origin: ${origin}`);
    }
    hosts.add(url.origin);
  }
  if (hosts.size === 0) {
    throw new Error('Recipe validation requires at least one allowed origin.');
  }
  return [...hosts];
}
