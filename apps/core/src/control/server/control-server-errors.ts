import fs from 'node:fs';
import type http from 'node:http';

import { logger } from '../../infrastructure/logging/logger.js';
import { sendError } from './http.js';

export function applyControlSocketMode(
  socketPath: string,
  server: Pick<http.Server, 'close'>,
): boolean {
  try {
    fs.chmodSync(socketPath, 0o600);
    return true;
  } catch (error) {
    logger.error(
      { err: error, socketPath },
      'Failed to set control socket mode to 0600; closing control server',
    );
    server.close();
    return false;
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

export function isControlClientDisconnectError(error: unknown): boolean {
  const code = getErrorCode(error);
  return (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ERR_STREAM_PREMATURE_CLOSE'
  );
}

export function logControlStreamError(error: unknown, path: string): void {
  if (isControlClientDisconnectError(error)) {
    logger.debug({ err: error, path }, 'Control client disconnected');
    return;
  }
  logger.warn({ err: error, path }, 'Control request stream error');
}

export function sendControlError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  if (res.destroyed || res.writableEnded) return;
  sendError(res, status, code, message);
}
