import {
  chromium,
  type Browser,
  type ConsoleMessage,
  type Page,
  type Request,
} from 'playwright-core';

import { nowMs, toIso } from '../../shared/time/datetime.js';

const BROWSER_CONNECTION_IDLE_MS = 120_000;

interface BrowserConsoleEntry {
  type: string;
  text: string;
  timestamp: string;
  location?: ReturnType<ConsoleMessage['location']>;
}

interface BrowserNetworkEntry {
  id: string;
  method: string;
  url: string;
  resourceType: string;
  timestamp: string;
  status?: number;
  ok?: boolean;
  failureText?: string;
}

export interface BrowserPageState {
  console: BrowserConsoleEntry[];
  pageErrors: Array<{ message: string; timestamp: string }>;
  network: BrowserNetworkEntry[];
  requestIds: WeakMap<Request, string>;
  nextRequestId: number;
}

export interface BrowserConnection {
  key: string;
  browser: Browser;
  idleTimer?: ReturnType<typeof setTimeout>;
  onDisconnected?: () => void;
}

interface PendingConnection {
  promise: Promise<BrowserConnection>;
  closeOnResolve: boolean;
}

const cachedConnections = new Map<string, BrowserConnection>();
const pendingConnections = new Map<string, PendingConnection>();
const pageStates = new WeakMap<Page, BrowserPageState>();
const observedPages = new WeakSet<Page>();

export async function getBrowserConnection(input: {
  key: string;
  cdpEndpoint: string;
  deadline: number;
  remainingMs: (deadline: number) => number;
  withTimeout: <T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ) => Promise<T>;
}): Promise<BrowserConnection> {
  const cached = cachedConnections.get(input.key);
  if (cached) {
    clearConnectionIdleTimer(cached);
    return cached;
  }
  const pending = pendingConnections.get(input.key);
  if (pending) {
    return await input.withTimeout(
      pending.promise,
      input.remainingMs(input.deadline),
      'Browser connection startup timed out.',
    );
  }
  const pendingEntry: PendingConnection = {
    closeOnResolve: false,
    promise: Promise.resolve(undefined as never),
  };
  pendingEntry.promise = createBrowserConnection(input).then(
    async (connection) => {
      if (!pendingEntry.closeOnResolve) return connection;
      await closeCachedConnection(input.key);
      throw new Error('Browser connection was closed before it became ready.');
    },
  );
  pendingEntry.promise.then(
    () => {
      if (pendingConnections.get(input.key) === pendingEntry) {
        pendingConnections.delete(input.key);
      }
    },
    () => {
      if (pendingConnections.get(input.key) === pendingEntry) {
        pendingConnections.delete(input.key);
      }
    },
  );
  pendingConnections.set(input.key, pendingEntry);
  return await input.withTimeout(
    pendingEntry.promise,
    input.remainingMs(input.deadline),
    'Browser connection startup timed out.',
  );
}

async function createBrowserConnection(input: {
  key: string;
  cdpEndpoint: string;
}): Promise<BrowserConnection> {
  const browser = await chromium.connectOverCDP(input.cdpEndpoint, {
    timeout: 10_000,
  });
  const connection: BrowserConnection = { key: input.key, browser };
  connection.onDisconnected = () => {
    const current = cachedConnections.get(input.key);
    if (current?.browser === browser) cachedConnections.delete(input.key);
  };
  browser.on('disconnected', connection.onDisconnected);
  cachedConnections.set(input.key, connection);
  for (const context of browser.contexts()) {
    for (const page of context.pages()) observePage(page);
    context.on('page', observePage);
  }
  return connection;
}

export function scheduleConnectionIdleClose(key: string): void {
  const connection = cachedConnections.get(key);
  if (!connection) return;
  clearConnectionIdleTimer(connection);
  connection.idleTimer = setTimeout(() => {
    closeCachedConnection(key).catch(() => undefined);
  }, BROWSER_CONNECTION_IDLE_MS);
  connection.idleTimer.unref?.();
}

export async function closeCachedConnection(key: string): Promise<void> {
  const connection = cachedConnections.get(key);
  if (!connection) return;
  cachedConnections.delete(key);
  clearConnectionIdleTimer(connection);
  if (
    connection.onDisconnected &&
    typeof connection.browser.off === 'function'
  ) {
    connection.browser.off('disconnected', connection.onDisconnected);
  }
  await connection.browser.close().catch(() => undefined);
}

export async function closeBrowserDirectConnections(
  profileName?: string,
): Promise<void> {
  const keys = [...cachedConnections.keys()].filter(
    (key) => !profileName || key.startsWith(`${profileName}\0`),
  );
  const pendingKeys = [...pendingConnections.entries()]
    .filter(([key]) => !profileName || key.startsWith(`${profileName}\0`))
    .map(([key, entry]) => {
      entry.closeOnResolve = true;
      return entry.promise
        .then(() => closeCachedConnection(key))
        .catch(() => undefined);
    });
  await Promise.all([
    ...keys.map((key) => closeCachedConnection(key)),
    ...pendingKeys,
  ]);
}

export async function allPages(browser: Browser): Promise<Page[]> {
  const pages = browser.contexts().flatMap((context) => context.pages());
  for (const page of pages) observePage(page);
  return pages;
}

export function firstContext(browser: Browser) {
  const context = browser.contexts()[0];
  if (!context)
    throw new Error('Connected browser did not expose a browser context.');
  return context;
}

export function observePage(page: Page): void {
  if (observedPages.has(page)) return;
  observedPages.add(page);
  pageState(page);
  page.on('console', (message) => {
    const state = pageState(page);
    state.console.push({
      type: message.type(),
      text: message.text(),
      timestamp: toIso(nowMs()),
      location: message.location(),
    });
    if (state.console.length > 500) state.console.shift();
  });
  page.on('pageerror', (err) => {
    const state = pageState(page);
    state.pageErrors.push({
      message: err.message,
      timestamp: toIso(nowMs()),
    });
    if (state.pageErrors.length > 200) state.pageErrors.shift();
  });
  page.on('request', (request) => {
    const state = pageState(page);
    const id = String(state.nextRequestId++);
    state.requestIds.set(request, id);
    state.network.push({
      id,
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      timestamp: toIso(nowMs()),
    });
    if (state.network.length > 500) state.network.shift();
  });
  page.on('requestfinished', async (request) => {
    const state = pageState(page);
    const entry = findNetworkEntry(state, request);
    const response = await request.response().catch(() => null);
    if (entry && response) {
      entry.status = response.status();
      entry.ok = response.ok();
    }
  });
  page.on('requestfailed', (request) => {
    const state = pageState(page);
    const entry = findNetworkEntry(state, request);
    if (entry) entry.failureText = request.failure()?.errorText;
  });
}

export function pageState(page: Page): BrowserPageState {
  const existing = pageStates.get(page);
  if (existing) return existing;
  const created: BrowserPageState = {
    console: [],
    pageErrors: [],
    network: [],
    requestIds: new WeakMap(),
    nextRequestId: 1,
  };
  pageStates.set(page, created);
  return created;
}

export async function safeTitle(page: Page): Promise<string> {
  return await page.title().catch(() => '');
}

function clearConnectionIdleTimer(connection: BrowserConnection): void {
  if (!connection.idleTimer) return;
  clearTimeout(connection.idleTimer);
  connection.idleTimer = undefined;
}

function findNetworkEntry(
  state: BrowserPageState,
  request: Request,
): BrowserNetworkEntry | undefined {
  const id = state.requestIds.get(request);
  return id ? state.network.find((entry) => entry.id === id) : undefined;
}
