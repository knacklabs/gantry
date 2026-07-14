import { createHash } from 'node:crypto';

export function durablePermissionCallbackId(requestId: string): string {
  return `p${createHash('sha256').update(requestId).digest('hex').slice(0, 24)}`;
}
