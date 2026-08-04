import { z } from 'zod';
import { formatBrowserToolResponse } from '../formatting.js';
import { requestBrowserAction } from '../ipc.js';
import { formatOperatorError } from '../../../shared/operator-error.js';
const DEFAULT_BROWSER_TOOL_TIMEOUT_MS = 120_000;
const FULL_INSPECT_MODES = new Set([
    'console_messages',
    'network_requests',
]);
const FULL_ACT_ACTIONS = new Set([
    'evaluate',
    'press_key',
    'hover',
    'drag',
    'drop',
    'select_option',
    'fill_form',
    'file_upload',
    'file_attach',
    'handle_dialog',
    'resize',
]);
function formatBrowserFailure(action, error) {
    return {
        content: [
            {
                type: 'text',
                text: formatOperatorError({
                    summary: 'Browser action failed.',
                    cause: `${action}: ${error || 'unknown error'}`,
                    recover: 'run gantry status and retry after the browser is ready.',
                }),
            },
        ],
        isError: true,
    };
}
function browserTimeoutMs(args) {
    const raw = args.timeout_ms;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return DEFAULT_BROWSER_TOOL_TIMEOUT_MS;
    }
    return Math.max(1_000, Math.min(DEFAULT_BROWSER_TOOL_TIMEOUT_MS, Math.trunc(raw)));
}
async function callBrowserBackend(publicToolName, action, payload, timeoutMs) {
    const response = await requestBrowserAction(action, payload, {
        timeoutMs,
        publicToolName,
    });
    if (!response.ok)
        return formatBrowserFailure(action, response.error);
    if (isBrowserMcpResult(response.data)) {
        return response.data;
    }
    return {
        content: [
            { type: 'text', text: formatBrowserToolResponse(response) },
        ],
    };
}
function isBrowserMcpResult(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const content = value.content;
    return Array.isArray(content);
}
function requireFullProfile(input) {
    if (input.profile === 'full' &&
        typeof input.reason === 'string' &&
        input.reason.trim()) {
        return null;
    }
    return formatBrowserFailure(input.publicToolName, 'profile="full" and a non-empty reason are required for this browser operation');
}
function register(server, name, description, schema, handler) {
    server.tool(name, `${description} Uses the host-derived Gantry browser profile. Add timeout_ms only to change the IPC/backend deadline.`, { ...schema, timeout_ms: z.number().optional() }, async (args) => (await handler(args)));
}
const profile = z
    .enum(['basic', 'full'])
    .optional()
    .describe('Use full only for higher-risk browser inspection or actions.');
const reason = z
    .string()
    .optional()
    .describe('Required with profile="full" for higher-risk browser operations.');
const fileName = z
    .string()
    .optional()
    .describe('Relative file name under the run browser artifact root.');
const target = z
    .string()
    .optional()
    .describe('Target handle from the latest browser inspection, or a unique selector.');
const payload = z
    .record(z.string(), z.unknown())
    .describe('Action-specific payload for the selected compact browser action.');
const inspectMode = z.enum([
    'snapshot',
    'tabs',
    'screenshot',
    'console_messages',
    'network_requests',
]);
const actAction = z.enum([
    'navigate',
    'back',
    'tab_new',
    'tab_select',
    'tab_close',
    'click',
    'type',
    'wait_for',
    'screenshot',
    'evaluate',
    'press_key',
    'hover',
    'drag',
    'drop',
    'select_option',
    'fill_form',
    'file_upload',
    'file_attach',
    'handle_dialog',
    'resize',
]);
export function registerBrowserTools(server) {
    register(server, 'browser_status', 'Inspect browser status without launching Chrome.', {}, async (args) => callBrowserBackend('browser_status', 'status', {}, browserTimeoutMs(args)));
    register(server, 'browser_open', 'Launch or reuse the headed browser profile, then optionally navigate.', {
        url: z.string().optional(),
        keep_alive_ms: z.number().optional(),
    }, async (args) => {
        const timeoutMs = browserTimeoutMs(args);
        const openPayload = typeof args.keep_alive_ms === 'number'
            ? { keep_alive_ms: args.keep_alive_ms }
            : {};
        const openResult = await callBrowserBackend('browser_open', 'open', openPayload, timeoutMs);
        if (isBrowserErrorResult(openResult) || typeof args.url !== 'string') {
            return openResult;
        }
        return callBrowserBackend('browser_open', 'navigate', { url: args.url }, timeoutMs);
    });
    register(server, 'browser_inspect', 'Inspect the current browser state through compact public modes.', {
        mode: inspectMode,
        profile,
        target,
        filename: fileName,
        reason,
    }, async (args) => {
        const mode = args.mode;
        if (FULL_INSPECT_MODES.has(mode)) {
            const failure = requireFullProfile({
                publicToolName: 'browser_inspect',
                profile: args.profile,
                reason: args.reason,
            });
            if (failure)
                return failure;
        }
        return callBrowserBackend('browser_inspect', inspectBackendAction(mode), inspectBackendPayload(mode, args), browserTimeoutMs(args));
    });
    register(server, 'browser_act', 'Perform a compact public browser action.', {
        action: actAction,
        profile,
        payload,
        reason,
    }, async (args) => {
        const action = args.action;
        if (FULL_ACT_ACTIONS.has(action)) {
            const failure = requireFullProfile({
                publicToolName: 'browser_act',
                profile: args.profile,
                reason: args.reason,
            });
            if (failure)
                return failure;
        }
        const actionPayload = args.payload && typeof args.payload === 'object'
            ? args.payload
            : {};
        return callBrowserBackend('browser_act', actBackendAction(action), actBackendPayload(action, actionPayload), browserTimeoutMs(args));
    });
    register(server, 'browser_close', 'Close the browser profile session.', {}, async (args) => callBrowserBackend('browser_close', 'close', {}, browserTimeoutMs(args)));
}
function isBrowserErrorResult(value) {
    return Boolean(value &&
        typeof value === 'object' &&
        value.isError === true);
}
function inspectBackendAction(mode) {
    switch (mode) {
        case 'snapshot':
            return 'snapshot';
        case 'tabs':
            return 'tabs';
        case 'screenshot':
            return 'screenshot';
        case 'console_messages':
            return 'console_messages';
        case 'network_requests':
            return 'network_requests';
    }
}
function inspectBackendPayload(mode, args) {
    if (mode === 'tabs')
        return { action: 'list' };
    const payload = {};
    if (typeof args.target === 'string')
        payload.target = args.target;
    if (typeof args.filename === 'string')
        payload.filename = args.filename;
    return payload;
}
function actBackendAction(action) {
    switch (action) {
        case 'navigate':
            return 'navigate';
        case 'back':
            return 'back';
        case 'tab_new':
        case 'tab_select':
        case 'tab_close':
            return 'tabs';
        case 'click':
            return 'click';
        case 'type':
            return 'type';
        case 'wait_for':
            return 'wait_for';
        case 'screenshot':
            return 'screenshot';
        case 'evaluate':
            return 'evaluate';
        case 'press_key':
            return 'press_key';
        case 'hover':
            return 'hover';
        case 'drag':
            return 'drag';
        case 'drop':
            return 'drop';
        case 'select_option':
            return 'select_option';
        case 'fill_form':
            return 'fill_form';
        case 'file_upload':
            return 'file_upload';
        case 'file_attach':
            return 'file_attach';
        case 'handle_dialog':
            return 'handle_dialog';
        case 'resize':
            return 'resize';
    }
}
function actBackendPayload(action, payload) {
    switch (action) {
        case 'back':
            return {};
        case 'tab_new':
            return { ...payload, action: 'new' };
        case 'tab_select':
            return { ...payload, action: 'select' };
        case 'tab_close':
            return { ...payload, action: 'close' };
        default:
            return payload;
    }
}
