import { createHash } from 'node:crypto';

const PGBOSS_KEY_PREFIX = 'gantry';

function pgBossKey(kind: string, value: string): string {
  return `${PGBOSS_KEY_PREFIX}.${kind}.${Buffer.from(value).toString('base64url')}`;
}

export function pgBossGroupId(workspaceKey: string): string {
  return pgBossKey('group', workspaceKey);
}

export function pgBossJobKey(jobId: string): string {
  return pgBossKey('job', jobId);
}

export function pgBossSendId(jobId: string, slot: string): string {
  const bytes = createHash('sha256')
    .update(`${PGBOSS_KEY_PREFIX}:send:${jobId}:${slot}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
