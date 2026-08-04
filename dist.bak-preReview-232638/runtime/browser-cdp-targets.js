import { nowMs } from '../shared/time/datetime.js';
const DEFAULT_CDP_TIMEOUT_MS = 5_000;
function cdpTimeoutMs(options) {
    const deadlineAtMs = options?.deadlineAtMs;
    if (typeof deadlineAtMs === 'number' && Number.isFinite(deadlineAtMs)) {
        const remainingMs = Math.trunc(deadlineAtMs - nowMs());
        if (remainingMs <= 0) {
            throw new Error('Browser CDP deadline exceeded');
        }
        return remainingMs;
    }
    const timeoutMs = options?.timeoutMs;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
        return DEFAULT_CDP_TIMEOUT_MS;
    }
    return Math.max(1, Math.trunc(timeoutMs));
}
async function cdpJsonRequest(port, endpoint, method = 'GET', options) {
    const timeoutMs = cdpTimeoutMs(options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
            method,
            signal: controller.signal,
        });
    }
    catch (err) {
        if (controller.signal.aborted) {
            throw new Error(`CDP HTTP ${method} ${endpoint} timed out`, {
                cause: err,
            });
        }
        throw err;
    }
    finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        throw new Error(`CDP HTTP ${response.status} for ${endpoint}`);
    }
    return response.json();
}
async function cdpTextRequest(port, endpoint, method = 'GET', options) {
    const timeoutMs = cdpTimeoutMs(options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
            method,
            signal: controller.signal,
        });
    }
    catch (err) {
        if (controller.signal.aborted) {
            throw new Error(`CDP HTTP ${method} ${endpoint} timed out`, {
                cause: err,
            });
        }
        throw err;
    }
    finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        throw new Error(`CDP HTTP ${response.status} for ${endpoint}`);
    }
    return response.text();
}
function runtimeWebSocketConstructor() {
    const ctor = globalThis
        .WebSocket;
    if (!ctor) {
        throw new Error('WebSocket is unavailable for CDP browser commands');
    }
    return ctor;
}
async function getBrowserWebSocketDebuggerUrl(port, options) {
    const version = await cdpJsonRequest(port, '/json/version', 'GET', options);
    if (!version || typeof version !== 'object') {
        throw new Error('CDP version response did not include browser metadata');
    }
    const webSocketDebuggerUrl = version
        .webSocketDebuggerUrl;
    if (typeof webSocketDebuggerUrl !== 'string' || !webSocketDebuggerUrl) {
        throw new Error('CDP version response did not include browser websocket');
    }
    return requireLocalCdpWebSocketUrl(webSocketDebuggerUrl, port);
}
function requireLocalCdpWebSocketUrl(rawUrl, port) {
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch (err) {
        throw new Error('CDP websocket URL is invalid', { cause: err });
    }
    const host = url.hostname.toLowerCase();
    const isLoopback = host === '127.0.0.1' ||
        host === 'localhost' ||
        host === '::1' ||
        host === '[::1]';
    if (url.protocol !== 'ws:' || !isLoopback || url.port !== String(port)) {
        throw new Error('CDP websocket URL must stay on the local browser port');
    }
    return url.toString();
}
async function cdpBrowserCommand(port, method, params, options) {
    const webSocketDebuggerUrl = await getBrowserWebSocketDebuggerUrl(port, options);
    const timeoutMs = cdpTimeoutMs(options);
    const WebSocketCtor = runtimeWebSocketConstructor();
    const socket = new WebSocketCtor(webSocketDebuggerUrl);
    const commandId = 1;
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            finish(new Error(`CDP command ${method} timed out`), undefined);
        }, timeoutMs);
        function finish(err, result) {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            socket.close();
            if (err) {
                reject(err);
            }
            else {
                resolve(result);
            }
        }
        socket.onopen = () => {
            socket.send(JSON.stringify({ id: commandId, method, params }));
        };
        socket.onerror = () => {
            finish(new Error(`CDP command ${method} websocket failed`), undefined);
        };
        socket.onclose = () => {
            finish(new Error(`CDP command ${method} websocket closed`), undefined);
        };
        socket.onmessage = (event) => {
            let message;
            try {
                message = JSON.parse(String(event.data));
            }
            catch {
                finish(new Error(`CDP command ${method} returned invalid JSON`), undefined);
                return;
            }
            if (message.id !== commandId)
                return;
            if (message.error) {
                finish(new Error(`CDP command ${method} failed: ${message.error.message || 'unknown error'}`), undefined);
                return;
            }
            finish(undefined, message.result);
        };
    });
}
async function cdpTargetCommand(port, webSocketDebuggerUrl, method, params, options) {
    const timeoutMs = cdpTimeoutMs(options);
    const WebSocketCtor = runtimeWebSocketConstructor();
    const socket = new WebSocketCtor(requireLocalCdpWebSocketUrl(webSocketDebuggerUrl, port));
    const commandId = 1;
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            finish(new Error(`CDP command ${method} timed out`), undefined);
        }, timeoutMs);
        function finish(err, result) {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            socket.close();
            if (err) {
                reject(err);
            }
            else {
                resolve(result);
            }
        }
        socket.onopen = () => {
            socket.send(JSON.stringify({ id: commandId, method, params }));
        };
        socket.onerror = () => {
            finish(new Error(`CDP command ${method} websocket failed`), undefined);
        };
        socket.onclose = () => {
            finish(new Error(`CDP command ${method} websocket closed`), undefined);
        };
        socket.onmessage = (event) => {
            let message;
            try {
                message = JSON.parse(String(event.data));
            }
            catch {
                finish(new Error(`CDP command ${method} returned invalid JSON`), undefined);
                return;
            }
            if (message.id !== commandId)
                return;
            if (message.error) {
                finish(new Error(`CDP command ${method} failed: ${message.error.message || 'unknown error'}`), undefined);
                return;
            }
            finish(undefined, message.result);
        };
    });
}
async function cdpBrowserSessionCommand(port, targetId, method, params, options) {
    const webSocketDebuggerUrl = await getBrowserWebSocketDebuggerUrl(port, options);
    const timeoutMs = cdpTimeoutMs(options);
    const WebSocketCtor = runtimeWebSocketConstructor();
    const socket = new WebSocketCtor(webSocketDebuggerUrl);
    return new Promise((resolve, reject) => {
        let settled = false;
        let nextCommandId = 1;
        let sessionId;
        const pending = new Map();
        const timer = setTimeout(() => {
            finish(new Error(`CDP command ${method} timed out`));
        }, timeoutMs);
        function sendCommand(commandMethod, commandParams, commandSessionId) {
            const id = nextCommandId;
            nextCommandId += 1;
            const message = {
                id,
                method: commandMethod,
                params: commandParams,
            };
            if (commandSessionId)
                message.sessionId = commandSessionId;
            const pendingResult = new Promise((commandResolve, commandReject) => {
                pending.set(id, {
                    method: commandMethod,
                    resolve: commandResolve,
                    reject: commandReject,
                });
            });
            socket.send(JSON.stringify(message));
            return pendingResult;
        }
        async function run() {
            const attached = (await sendCommand('Target.attachToTarget', {
                targetId,
                flatten: true,
            }));
            const attachedSessionId = attached?.sessionId;
            if (typeof attachedSessionId !== 'string' || !attachedSessionId) {
                throw new Error('CDP Target.attachToTarget did not return sessionId');
            }
            sessionId = attachedSessionId;
            await sendCommand(method, params, sessionId);
        }
        function finish(err) {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            socket.close();
            for (const command of pending.values()) {
                command.reject(err ||
                    new Error(`CDP command ${command.method} was cancelled before completion`));
            }
            pending.clear();
            if (err) {
                reject(err);
            }
            else {
                resolve();
            }
        }
        socket.onopen = () => {
            run()
                .then(() => sessionId
                ? sendCommand('Target.detachFromTarget', { sessionId }).then(() => undefined)
                : undefined)
                .then(() => finish())
                .catch((err) => finish(err instanceof Error ? err : new Error(String(err))));
        };
        socket.onerror = () => {
            finish(new Error(`CDP command ${method} websocket failed`));
        };
        socket.onclose = () => {
            finish(new Error(`CDP command ${method} websocket closed`));
        };
        socket.onmessage = (event) => {
            let message;
            try {
                message = JSON.parse(String(event.data));
            }
            catch {
                finish(new Error(`CDP command ${method} returned invalid JSON`));
                return;
            }
            if (typeof message.id !== 'number')
                return;
            const command = pending.get(message.id);
            if (!command)
                return;
            pending.delete(message.id);
            if (message.error) {
                command.reject(new Error(`CDP command ${command.method} failed: ${message.error.message || 'unknown error'}`));
                return;
            }
            command.resolve(message.result);
        };
    });
}
function isInternalChromeTargetText(value) {
    const normalized = value.trim().toLowerCase();
    return (normalized.startsWith('chrome://new-tab-page') ||
        normalized.startsWith('chrome://omnibox-popup') ||
        normalized === 'omnibox popup' ||
        normalized.includes('omnibox popup'));
}
function isInternalChromeTarget(row) {
    return [row.url, row.title].some((value) => typeof value === 'string' && isInternalChromeTargetText(value));
}
export async function activateBrowserTarget(port, targetId, options) {
    await cdpBrowserCommand(port, 'Target.activateTarget', { targetId }, options);
}
export async function foregroundBrowserTarget(port, targetId, options) {
    await activateBrowserTarget(port, targetId, options);
    const pageTargets = await listPageTargets(port, options);
    const target = pageTargets.find((row) => row.id === targetId);
    const webSocketDebuggerUrl = target && typeof target.webSocketDebuggerUrl === 'string'
        ? target.webSocketDebuggerUrl
        : '';
    if (webSocketDebuggerUrl) {
        await cdpTargetCommand(port, webSocketDebuggerUrl, 'Page.bringToFront', {}, options);
        return;
    }
    await cdpBrowserSessionCommand(port, targetId, 'Page.bringToFront', {}, options);
}
export async function resizeHeadedBrowserWindow(port, targetId, width, height, options) {
    const normalizedWidth = Math.trunc(width);
    const normalizedHeight = Math.trunc(height);
    if (normalizedWidth <= 0 || normalizedHeight <= 0) {
        throw new Error('Browser resize width and height must be positive numbers');
    }
    const windowForTarget = await cdpBrowserCommand(port, 'Browser.getWindowForTarget', { targetId }, options);
    const windowId = windowForTarget?.windowId;
    if (typeof windowId !== 'number') {
        throw new Error('CDP Browser.getWindowForTarget did not return windowId');
    }
    await cdpBrowserCommand(port, 'Browser.setWindowBounds', {
        windowId,
        bounds: {
            windowState: 'normal',
            width: normalizedWidth,
            height: normalizedHeight,
        },
    }, options);
}
async function closeInternalTargets(port, targetIds, options) {
    await Promise.all([...new Set(targetIds)].map((targetId) => cdpTextRequest(port, `/json/close/${targetId}`, 'GET', options).catch(() => '')));
}
async function listPageTargets(port, options) {
    const list = await cdpJsonRequest(port, '/json/list', 'GET', options);
    if (!Array.isArray(list))
        return [];
    return list.filter((entry) => {
        if (!entry || typeof entry !== 'object')
            return false;
        const row = entry;
        const id = typeof row.id === 'string' ? row.id : '';
        const type = typeof row.type === 'string' ? row.type : '';
        return Boolean(id) && (!type || type === 'page');
    });
}
async function closeInternalPageTargets(port, options) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const targets = await listPageTargets(port, options);
        const internalTargets = targets.flatMap((row) => {
            const id = typeof row.id === 'string' ? row.id : '';
            return id && isInternalChromeTarget(row) ? [id] : [];
        });
        if (internalTargets.length === 0)
            return;
        await closeInternalTargets(port, internalTargets, options);
    }
}
export async function ensureBrowserTarget(port, options) {
    await closeInternalPageTargets(port, options);
    const pageTargets = await listPageTargets(port, options);
    if (pageTargets.length > 0) {
        for (const row of pageTargets) {
            const id = typeof row.id === 'string' ? row.id : '';
            if (id && isInternalChromeTarget(row))
                await closeInternalTargets(port, [id], options);
        }
        const firstContentPage = pageTargets.find((row) => {
            return !isInternalChromeTarget(row);
        });
        const id = firstContentPage && typeof firstContentPage.id === 'string'
            ? firstContentPage.id
            : '';
        if (id) {
            await activateBrowserTarget(port, id, options);
            await closeInternalPageTargets(port, options);
            return id;
        }
    }
    let created;
    try {
        created = await cdpJsonRequest(port, '/json/new?about:blank', 'PUT', options);
    }
    catch {
        created = await cdpJsonRequest(port, '/json/new?about:blank', 'GET', options);
    }
    if (created && typeof created === 'object') {
        const id = typeof created.id === 'string'
            ? created.id
            : '';
        if (id) {
            await activateBrowserTarget(port, id, options);
            await closeInternalPageTargets(port, options);
            return id;
        }
    }
    return undefined;
}
