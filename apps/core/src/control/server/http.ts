import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { ApplicationError } from '../../application/common/application-error.js';
import { logger } from '../../infrastructure/logging/logger.js';

export type ControlRequestLogEntry = {
  route: string;
  method: string;
  statusCode: number;
  apiKeyId?: string;
  appId?: string;
  modelAlias?: string;
  modelRouteId?: string;
  requestBodyBytes?: number;
  responseBodyBytes?: number;
  clientDisconnected?: boolean;
};

export type ControlRequestLogSink = (
  entry: ControlRequestLogEntry,
) => Promise<void> | void;

let controlRequestLogSink: ControlRequestLogSink = (entry) => {
  logger.info(entry, 'Control request completed');
};

export function configureControlRequestLogSink(
  sink: ControlRequestLogSink,
): () => void {
  const previous = controlRequestLogSink;
  controlRequestLogSink = sink;
  return () => {
    controlRequestLogSink = previous;
  };
}

export async function recordControlRequestLog(
  entry: ControlRequestLogEntry,
): Promise<void> {
  try {
    await controlRequestLogSink(entry);
  } catch (error) {
    logger.warn({ err: error }, 'Control request log sink failed');
  }
}

export function readRawBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function readJson(
  req: IncomingMessage,
  maxBytes = 64 * 1024,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
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
      } catch {
        reject(
          Object.assign(new Error('Invalid JSON body'), {
            code: 'INVALID_JSON',
            statusCode: 400,
          }),
        );
      }
    });
    req.on('error', reject);
  });
}

function parseContentLength(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  return Number(raw || 0);
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(`${JSON.stringify(body)}\n`);
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
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

export function sendApplicationError(
  res: ServerResponse,
  error: unknown,
  overrides?: Partial<Record<ApplicationError['code'], string>>,
): boolean {
  if (!(error instanceof ApplicationError)) return false;
  switch (error.code) {
    case 'NOT_FOUND':
      sendError(res, 404, overrides?.NOT_FOUND ?? 'NOT_FOUND', error.message);
      return true;
    case 'TRIGGER_NOT_FOUND':
      sendError(
        res,
        404,
        overrides?.TRIGGER_NOT_FOUND ?? 'TRIGGER_NOT_FOUND',
        error.message,
      );
      return true;
    case 'FORBIDDEN':
      sendError(res, 403, overrides?.FORBIDDEN ?? 'FORBIDDEN', error.message);
      return true;
    case 'INVALID_REQUEST':
    case 'INVALID_SCHEDULE':
    case 'INVALID_CONTROL_ALLOWLIST':
      sendError(
        res,
        400,
        overrides?.[error.code] ?? 'INVALID_REQUEST',
        error.message,
      );
      return true;
    case 'CONFLICT':
      sendError(res, 409, overrides?.CONFLICT ?? 'CONFLICT', error.message);
      return true;
    case 'RATE_LIMITED':
      sendError(
        res,
        429,
        overrides?.RATE_LIMITED ?? 'RATE_LIMITED',
        error.message,
      );
      return true;
    case 'WAIT_TIMEOUT':
      sendError(
        res,
        408,
        overrides?.WAIT_TIMEOUT ?? 'WAIT_TIMEOUT',
        error.message,
      );
      return true;
    case 'SCHEDULER_NOT_READY':
      sendError(
        res,
        503,
        overrides?.SCHEDULER_NOT_READY ?? 'SCHEDULER_NOT_READY',
        error.message,
      );
      return true;
    case 'UNAVAILABLE':
      sendError(
        res,
        503,
        overrides?.UNAVAILABLE ?? 'UNAVAILABLE',
        error.message,
      );
      return true;
    case 'ENQUEUE_FAILED':
      sendError(
        res,
        500,
        overrides?.ENQUEUE_FAILED ?? 'ENQUEUE_FAILED',
        error.message,
      );
      return true;
    case 'NOT_IMPLEMENTED':
      sendError(
        res,
        501,
        overrides?.NOT_IMPLEMENTED ?? 'NOT_IMPLEMENTED',
        error.message,
      );
      return true;
  }
}
