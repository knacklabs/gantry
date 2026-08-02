import { randomUUID } from 'node:crypto';
import { ApplicationError } from '../../application/common/application-error.js';
import { logger } from '../../infrastructure/logging/logger.js';
let controlRequestLogSink = (entry) => {
    logger.info(entry, 'Control request completed');
};
export function configureControlRequestLogSink(sink) {
    const previous = controlRequestLogSink;
    controlRequestLogSink = sink;
    return () => {
        controlRequestLogSink = previous;
    };
}
export async function recordControlRequestLog(entry) {
    try {
        await controlRequestLogSink(entry);
    }
    catch (error) {
        logger.warn({ err: error }, 'Control request log sink failed');
    }
}
export function readRawBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;
        let settled = false;
        const cleanup = () => {
            req.off('data', onData);
            req.off('end', onEnd);
            req.off('error', onError);
            req.off('aborted', onAborted);
            req.off('close', onClose);
        };
        const resolveOnce = (body) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(body);
        };
        const rejectOnce = (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(error);
        };
        const requestAbortedError = () => Object.assign(new Error('Request body stream aborted'), {
            code: 'REQUEST_ABORTED',
            statusCode: 400,
        });
        const onData = (chunk) => {
            const buffer = Buffer.from(chunk);
            totalBytes += buffer.length;
            if (totalBytes > maxBytes) {
                const error = Object.assign(new Error('Payload too large'), {
                    code: 'PAYLOAD_TOO_LARGE',
                    statusCode: 413,
                });
                rejectOnce(error);
                // destroy() with no arg: rejectOnce already ran cleanup(), removing the
                // 'error' listener, so passing the error here would re-emit it on a
                // listenerless stream as an uncaught exception.
                req.destroy();
                return;
            }
            chunks.push(buffer);
        };
        const onEnd = () => resolveOnce(Buffer.concat(chunks));
        const onError = (error) => rejectOnce(error);
        const onAborted = () => rejectOnce(requestAbortedError());
        const onClose = () => {
            if (req.complete !== true)
                rejectOnce(requestAbortedError());
        };
        const contentLength = parseContentLength(req.headers['content-length']);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            const error = Object.assign(new Error('Payload too large'), {
                code: 'PAYLOAD_TOO_LARGE',
                statusCode: 413,
            });
            rejectOnce(error);
            req.destroy();
            return;
        }
        req.on('data', onData);
        req.on('end', onEnd);
        req.on('error', onError);
        req.on('aborted', onAborted);
        req.on('close', onClose);
    });
}
export function readJson(req, maxBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;
        const contentLength = parseContentLength(req.headers['content-length']);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            const error = Object.assign(new Error('Payload too large'), {
                code: 'PAYLOAD_TOO_LARGE',
                statusCode: 413,
            });
            reject(error);
            req.destroy();
            return;
        }
        req.on('data', (chunk) => {
            const buffer = Buffer.from(chunk);
            totalBytes += buffer.length;
            if (totalBytes > maxBytes) {
                const error = Object.assign(new Error('Payload too large'), {
                    code: 'PAYLOAD_TOO_LARGE',
                    statusCode: 413,
                });
                reject(error);
                req.destroy(error);
                return;
            }
            chunks.push(buffer);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            if (!raw) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            }
            catch {
                reject(Object.assign(new Error('Invalid JSON body'), {
                    code: 'INVALID_JSON',
                    statusCode: 400,
                }));
            }
        });
        req.on('error', reject);
    });
}
function parseContentLength(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    return Number(raw || 0);
}
export function sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(`${JSON.stringify(body)}\n`);
}
export function sendError(res, status, code, message, details) {
    sendJson(res, status, {
        error: {
            code,
            message,
            details: details ?? null,
            retryable: status >= 500,
            requestId: randomUUID(),
        },
    });
}
export function sendApplicationError(res, error, overrides) {
    if (!(error instanceof ApplicationError))
        return false;
    switch (error.code) {
        case 'NOT_FOUND':
            sendError(res, 404, overrides?.NOT_FOUND ?? 'NOT_FOUND', error.message);
            return true;
        case 'TRIGGER_NOT_FOUND':
            sendError(res, 404, overrides?.TRIGGER_NOT_FOUND ?? 'TRIGGER_NOT_FOUND', error.message);
            return true;
        case 'FORBIDDEN':
            sendError(res, 403, overrides?.FORBIDDEN ?? 'FORBIDDEN', error.message);
            return true;
        case 'INVALID_REQUEST':
        case 'INVALID_SCHEDULE':
        case 'INVALID_CONTROL_ALLOWLIST':
            sendError(res, 400, overrides?.[error.code] ?? 'INVALID_REQUEST', error.message);
            return true;
        case 'CONFLICT':
            sendError(res, 409, overrides?.CONFLICT ?? 'CONFLICT', error.message);
            return true;
        case 'RATE_LIMITED':
            sendError(res, 429, overrides?.RATE_LIMITED ?? 'RATE_LIMITED', error.message);
            return true;
        case 'WAIT_TIMEOUT':
            sendError(res, 408, overrides?.WAIT_TIMEOUT ?? 'WAIT_TIMEOUT', error.message);
            return true;
        case 'SCHEDULER_NOT_READY':
            sendError(res, 503, overrides?.SCHEDULER_NOT_READY ?? 'SCHEDULER_NOT_READY', error.message);
            return true;
        case 'UNAVAILABLE':
            sendError(res, 503, overrides?.UNAVAILABLE ?? 'UNAVAILABLE', error.message);
            return true;
        case 'ENQUEUE_FAILED':
            sendError(res, 500, overrides?.ENQUEUE_FAILED ?? 'ENQUEUE_FAILED', error.message);
            return true;
        case 'NOT_IMPLEMENTED':
            sendError(res, 501, overrides?.NOT_IMPLEMENTED ?? 'NOT_IMPLEMENTED', error.message);
            return true;
    }
}
