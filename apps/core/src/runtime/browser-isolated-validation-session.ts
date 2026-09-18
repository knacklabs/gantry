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
  readonly context: BrowserContext;
  readonly page: Page;
  readonly deadlineAtMs: number;
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
    });
    const page = await context.newPage();
    observePage(page);
    return await withTimeout(
      input.execute({ context, page, deadlineAtMs }),
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
