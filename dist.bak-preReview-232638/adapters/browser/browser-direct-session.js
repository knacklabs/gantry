import { chromium, } from 'playwright-core';
import { nowMs, toIso } from '../../shared/time/datetime.js';
const BROWSER_CONNECTION_IDLE_MS = 120_000;
const cachedConnections = new Map();
const pendingConnections = new Map();
const pageStates = new WeakMap();
const observedPages = new WeakSet();
export async function getBrowserConnection(input) {
    const cached = cachedConnections.get(input.key);
    if (cached) {
        clearConnectionIdleTimer(cached);
        return cached;
    }
    const pending = pendingConnections.get(input.key);
    if (pending) {
        return await input.withTimeout(pending.promise, input.remainingMs(input.deadline), 'Browser connection startup timed out.');
    }
    const pendingEntry = {
        closeOnResolve: false,
        promise: Promise.resolve(undefined),
    };
    pendingEntry.promise = createBrowserConnection(input).then(async (connection) => {
        if (!pendingEntry.closeOnResolve)
            return connection;
        await closeCachedConnection(input.key);
        throw new Error('Browser connection was closed before it became ready.');
    });
    pendingEntry.promise.then(() => {
        if (pendingConnections.get(input.key) === pendingEntry) {
            pendingConnections.delete(input.key);
        }
    }, () => {
        if (pendingConnections.get(input.key) === pendingEntry) {
            pendingConnections.delete(input.key);
        }
    });
    pendingConnections.set(input.key, pendingEntry);
    return await input.withTimeout(pendingEntry.promise, input.remainingMs(input.deadline), 'Browser connection startup timed out.');
}
async function createBrowserConnection(input) {
    const browser = await chromium.connectOverCDP(input.cdpEndpoint, {
        timeout: 10_000,
    });
    const connection = { key: input.key, browser };
    connection.onDisconnected = () => {
        const current = cachedConnections.get(input.key);
        if (current?.browser === browser)
            cachedConnections.delete(input.key);
    };
    browser.on('disconnected', connection.onDisconnected);
    cachedConnections.set(input.key, connection);
    for (const context of browser.contexts()) {
        for (const page of context.pages())
            observePage(page);
        context.on('page', observePage);
    }
    return connection;
}
export function scheduleConnectionIdleClose(key) {
    const connection = cachedConnections.get(key);
    if (!connection)
        return;
    clearConnectionIdleTimer(connection);
    connection.idleTimer = setTimeout(() => {
        closeCachedConnection(key).catch(() => undefined);
    }, BROWSER_CONNECTION_IDLE_MS);
    connection.idleTimer.unref?.();
}
export async function closeCachedConnection(key) {
    const connection = cachedConnections.get(key);
    if (!connection)
        return;
    cachedConnections.delete(key);
    clearConnectionIdleTimer(connection);
    if (connection.onDisconnected &&
        typeof connection.browser.off === 'function') {
        connection.browser.off('disconnected', connection.onDisconnected);
    }
    await connection.browser.close().catch(() => undefined);
}
export async function closeBrowserDirectConnections(profileName) {
    const keys = [...cachedConnections.keys()].filter((key) => !profileName || key.startsWith(`${profileName}\0`));
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
export async function allPages(browser) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    for (const page of pages)
        observePage(page);
    return pages;
}
export function firstContext(browser) {
    const context = browser.contexts()[0];
    if (!context)
        throw new Error('Connected browser did not expose a browser context.');
    return context;
}
export function observePage(page) {
    if (observedPages.has(page))
        return;
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
        if (state.console.length > 500)
            state.console.shift();
    });
    page.on('pageerror', (err) => {
        const state = pageState(page);
        state.pageErrors.push({
            message: err.message,
            timestamp: toIso(nowMs()),
        });
        if (state.pageErrors.length > 200)
            state.pageErrors.shift();
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
        if (state.network.length > 500)
            state.network.shift();
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
        if (entry)
            entry.failureText = request.failure()?.errorText;
    });
}
export function pageState(page) {
    const existing = pageStates.get(page);
    if (existing)
        return existing;
    const created = {
        console: [],
        pageErrors: [],
        network: [],
        requestIds: new WeakMap(),
        nextRequestId: 1,
    };
    pageStates.set(page, created);
    return created;
}
export async function safeTitle(page) {
    return await page.title().catch(() => '');
}
function clearConnectionIdleTimer(connection) {
    if (!connection.idleTimer)
        return;
    clearTimeout(connection.idleTimer);
    connection.idleTimer = undefined;
}
function findNetworkEntry(state, request) {
    const id = state.requestIds.get(request);
    return id ? state.network.find((entry) => entry.id === id) : undefined;
}
