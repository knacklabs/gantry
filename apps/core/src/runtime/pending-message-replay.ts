import { createHash } from 'node:crypto';

export function buildPendingMessagesContinuationIdempotencyKey(input: {
  itemIds: readonly string[];
}): string {
  const hash = createHash('sha256');
  for (const itemId of input.itemIds) {
    hash.update(itemId);
    hash.update('\0');
  }
  return `continuation:${hash.digest('hex')}`;
}
