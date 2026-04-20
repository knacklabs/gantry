import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { MYCLAW_IPC_AUTH_SECRET } from '../core/config.js';
import { logger } from '../core/logger.js';

const IPC_AUTH_SECRET =
  MYCLAW_IPC_AUTH_SECRET ||
  (() => {
    const generated = randomBytes(32).toString('hex');
    logger.warn(
      'MYCLAW_IPC_AUTH_SECRET not set; using ephemeral secret (IPC tokens will not survive restarts)',
    );
    return generated;
  })();

export function computeIpcAuthToken(groupFolder: string): string {
  return createHmac('sha256', IPC_AUTH_SECRET)
    .update(groupFolder)
    .digest('hex');
}

export function validateIpcAuthToken(
  groupFolder: string,
  candidateToken: string,
): boolean {
  if (!candidateToken) return false;
  const expected = computeIpcAuthToken(groupFolder);
  if (candidateToken.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidateToken), Buffer.from(expected));
}
