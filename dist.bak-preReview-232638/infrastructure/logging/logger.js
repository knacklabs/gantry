import { AsyncLocalStorage } from 'node:async_hooks';
import { nowIso, systemClock, toIso, } from '../../shared/time/datetime.js';
import { isPlainObject } from '../../shared/object.js';
const LOG_LEVEL_PRIORITY = {
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60,
};
const logContextStorage = new AsyncLocalStorage();
export function withLogContext(context, callback) {
    return logContextStorage.run({ ...logContextStorage.getStore(), ...context }, callback);
}
export function updateLogContext(context) {
    const current = logContextStorage.getStore();
    if (current)
        Object.assign(current, context);
}
export function currentLogContext() {
    return logContextStorage.getStore();
}
const DEFAULT_REDACT_KEY_PATTERN = /(token|secret|password|credential|api[_-]?key|access[_-]?key|private[_-]?key|serviceAccountJson|authorization|auth|^(?:sessionId|newSessionId|providerSessionId|externalSessionId|latestProviderSessionId|session_id)$)/i;
const PROVIDER_SESSION_FIELD_NAMES = 'sessionId|newSessionId|providerSessionId|externalSessionId|latestProviderSessionId|session_id';
const PROVIDER_SESSION_TEXT_PATTERNS = [
    new RegExp(`(["'](?:${PROVIDER_SESSION_FIELD_NAMES})["']\\s*:\\s*")([^"\\r\\n]*)(")`, 'gi'),
    new RegExp(`(["'](?:${PROVIDER_SESSION_FIELD_NAMES})["']\\s*:\\s*')([^'\\r\\n]*)(')`, 'gi'),
    new RegExp(`\\b((?:${PROVIDER_SESSION_FIELD_NAMES})\\s*[:=]\\s*)([^\\s"',}\\]]+)`, 'gi'),
    new RegExp(`\\b((?:${PROVIDER_SESSION_FIELD_NAMES})\\s+)([^\\s"',}\\]]+)`, 'gi'),
];
const CREDENTIAL_TEXT_FIELD_NAMES = 'accessKeyId|secretAccessKey|sessionToken|serviceAccountJson|private_key|privateKey';
const CREDENTIAL_TEXT_PATTERNS = [
    new RegExp(`\\b(serviceAccountJson\\s*[:=]\\s*)(\\{[^\\r\\n]*\\})()`, 'gi'),
    new RegExp(`(["'](?:${CREDENTIAL_TEXT_FIELD_NAMES})["']\\s*:\\s*")([^"\\r\\n]*)(")`, 'gi'),
    new RegExp(`(["'](?:${CREDENTIAL_TEXT_FIELD_NAMES})["']\\s*:\\s*')([^'\\r\\n]*)(')`, 'gi'),
    new RegExp(`\\b((?:${CREDENTIAL_TEXT_FIELD_NAMES})\\s*[:=]\\s*)((?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,}\\]]+))()`, 'gi'),
];
const SECRET_VALUE_PATTERNS = [
    /\bclaude-session-[A-Za-z0-9._:-]+\b/g,
    /\bprovider-session:[A-Za-z0-9._:-]+\b/g,
    /\bgtw_[A-Za-z0-9._-]+\b/g,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    /\bsk-ant-[A-Za-z0-9._-]+\b/g,
    /\bsk-[A-Za-z0-9]{20,}\b/g,
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gi,
    /"private_key"\s*:\s*"[^"]*"/gi,
    /\bserviceAccountJson\s*=\s*\{[^\r\n]*\}/g,
    /\bxox[baprs]-[A-Za-z0-9-]+\b/g,
    /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g,
    /\b(postgres(?:ql)?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    /(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/g,
    /([?&](?:password|passwd|pass|token|secret|api[_-]?key)=)[^&\s'"]+/gi,
    /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY)[A-Z0-9_]*)=([^\s]+)/gi,
    /"([A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY)[A-Z0-9_]*)"\s*:\s*"[^"]*"/gi,
    /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY)[A-Z0-9_]*)\s*:\s*["']?[^"',\s}]+["']?/gi,
    /\b(PASSWORD\s+)'[^']*'/gi,
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+\b/gi,
];
const LOGGER_HANDLER_MARK = Symbol.for('gantry.logger.handler');
function sanitizeError(err, depth = 0) {
    const extra = {};
    for (const key of [
        'code',
        'detail',
        'constraint',
        'table',
        'schema',
        'column',
    ]) {
        const value = err[key];
        if (typeof value === 'string' && value.length > 0) {
            extra[key] = redactString(value);
        }
    }
    const cause = err.cause;
    return {
        type: err.constructor.name,
        message: redactString(err.message),
        stack: err.stack ? redactString(err.stack) : undefined,
        ...extra,
        ...(cause === undefined
            ? {}
            : {
                cause: depth >= 5 ? '[TRUNCATED_DEPTH]' : redactValue(cause, depth + 1),
            }),
    };
}
function defaultRedact(value) {
    return redactValue(value, 0);
}
function redactValue(value, depth) {
    if (depth > 6)
        return '[TRUNCATED_DEPTH]';
    if (value instanceof Error)
        return sanitizeError(value, depth);
    if (typeof value === 'string')
        return redactString(value);
    if (Array.isArray(value)) {
        return value.map((entry) => redactValue(entry, depth + 1));
    }
    if (isPlainObject(value)) {
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            if (DEFAULT_REDACT_KEY_PATTERN.test(key)) {
                out[key] = '[REDACTED]';
                continue;
            }
            out[key] = redactValue(entry, depth + 1);
        }
        return out;
    }
    return value;
}
export function redactString(value) {
    let out = value;
    for (const pattern of PROVIDER_SESSION_TEXT_PATTERNS) {
        out = out.replace(pattern, (_match, prefix, _secret, suffix = '') => {
            return `${prefix}[REDACTED]${suffix}`;
        });
    }
    for (const pattern of CREDENTIAL_TEXT_PATTERNS) {
        out = out.replace(pattern, (_match, prefix, _secret, suffix = '') => {
            return `${prefix}[REDACTED]${suffix}`;
        });
    }
    for (const pattern of SECRET_VALUE_PATTERNS) {
        out = out.replace(pattern, (_match, first) => {
            if (typeof first === 'string' &&
                /^(https?|postgres(?:ql)?):\/\//i.test(first)) {
                return `${first}[REDACTED]@`;
            }
            if (typeof first === 'string' && first.startsWith('?')) {
                return `${first}[REDACTED]`;
            }
            if (typeof first === 'string' && first.startsWith('&')) {
                return `${first}[REDACTED]`;
            }
            if (typeof first === 'string' &&
                /(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY)/i.test(first)) {
                return /\s$/.test(first)
                    ? `${first}'[REDACTED]'`
                    : /:\s*$/.test(first)
                        ? `${first}"[REDACTED]"`
                        : `${first}=[REDACTED]`;
            }
            return '[REDACTED]';
        });
    }
    return out;
}
function createTextSink(opts) {
    return {
        write(record) {
            const forceStderr = opts.stderrOnly === true;
            const stream = forceStderr ||
                LOG_LEVEL_PRIORITY[record.level] >= LOG_LEVEL_PRIORITY.warn
                ? process.stderr
                : process.stdout;
            if (!record.context || Object.keys(record.context).length === 0) {
                stream.write(`[${record.timestamp}] ${record.level.toUpperCase()} (${record.pid}): ${record.message}\n`);
                return;
            }
            stream.write(`[${record.timestamp}] ${record.level.toUpperCase()} (${record.pid}): ${record.message} ${JSON.stringify(record.context)}\n`);
        },
    };
}
function createJsonSink(opts) {
    return {
        write(record) {
            const forceStderr = opts.stderrOnly === true;
            const stream = forceStderr ||
                LOG_LEVEL_PRIORITY[record.level] >= LOG_LEVEL_PRIORITY.warn
                ? process.stderr
                : process.stdout;
            stream.write(`${JSON.stringify(record)}\n`);
        },
    };
}
function mergeContexts(left, right) {
    if (!left && !right)
        return undefined;
    return {
        ...(left || {}),
        ...(right || {}),
    };
}
function normalizeLevel(raw) {
    const value = (raw || '').trim().toLowerCase();
    if (value === 'debug' ||
        value === 'info' ||
        value === 'warn' ||
        value === 'error' ||
        value === 'fatal') {
        return value;
    }
    return 'info';
}
export function createLogger(options = {}) {
    const level = options.level || normalizeLevel(process.env.LOG_LEVEL);
    const clock = options.clock || systemClock;
    const redact = options.redact || defaultRedact;
    const baseContext = options.context;
    const stderrOnly = process.env.GANTRY_LOG_STDERR === '1';
    const sink = options.sink ||
        (options.format === 'json'
            ? createJsonSink({ stderrOnly })
            : createTextSink({ stderrOnly }));
    const log = (currentLevel, dataOrMsg, msg, childContext) => {
        if (LOG_LEVEL_PRIORITY[currentLevel] < LOG_LEVEL_PRIORITY[level])
            return;
        const message = typeof dataOrMsg === 'string'
            ? redactString(dataOrMsg)
            : redactString(msg || '');
        const activeContext = currentLogContext();
        const inheritedContext = mergeContexts(mergeContexts(baseContext, activeContext), childContext);
        const record = {
            timestamp: nowIso(clock),
            level: currentLevel,
            message,
            pid: process.pid,
            ...(() => {
                if (typeof dataOrMsg === 'string') {
                    const context = redact(inheritedContext);
                    return context ? { context } : {};
                }
                const context = redact(mergeContexts(inheritedContext, dataOrMsg));
                return context ? { context } : {};
            })(),
        };
        sink.write(record);
    };
    const makeChildLogger = (childContext) => ({
        debug: (dataOrMsg, msg) => log('debug', dataOrMsg, msg, childContext),
        info: (dataOrMsg, msg) => log('info', dataOrMsg, msg, childContext),
        warn: (dataOrMsg, msg) => log('warn', dataOrMsg, msg, childContext),
        error: (dataOrMsg, msg) => log('error', dataOrMsg, msg, childContext),
        fatal: (dataOrMsg, msg) => log('fatal', dataOrMsg, msg, childContext),
        child: (nextContext) => makeChildLogger(mergeContexts(childContext, nextContext)),
    });
    return makeChildLogger();
}
export const logger = createLogger({
    format: process.env.LOG_FORMAT === 'json' ? 'json' : 'text',
});
function removeMarkedProcessListeners(event) {
    if (event === 'uncaughtException') {
        for (const listener of process.listeners(event)) {
            if (listener[LOGGER_HANDLER_MARK]) {
                process.removeListener(event, listener);
            }
        }
        return;
    }
    for (const listener of process.listeners(event)) {
        if (listener[LOGGER_HANDLER_MARK]) {
            process.removeListener(event, listener);
        }
    }
}
export function installGlobalErrorHandlers(target = logger) {
    removeMarkedProcessListeners('uncaughtException');
    removeMarkedProcessListeners('unhandledRejection');
    const uncaughtExceptionHandler = ((err) => {
        target.fatal({ err }, 'Uncaught exception');
        process.exit(1);
    });
    uncaughtExceptionHandler[LOGGER_HANDLER_MARK] = true;
    const unhandledRejectionHandler = ((reason) => {
        target.error({ err: reason }, 'Unhandled rejection');
    });
    unhandledRejectionHandler[LOGGER_HANDLER_MARK] = true;
    process.on('uncaughtException', uncaughtExceptionHandler);
    process.on('unhandledRejection', unhandledRejectionHandler);
    return () => {
        process.removeListener('uncaughtException', uncaughtExceptionHandler);
        process.removeListener('unhandledRejection', unhandledRejectionHandler);
    };
}
export function createLogRecord(level, message, context, clock = systemClock) {
    return {
        level,
        message,
        pid: process.pid,
        timestamp: toIso(clock.now()),
        ...(context ? { context } : {}),
    };
}
