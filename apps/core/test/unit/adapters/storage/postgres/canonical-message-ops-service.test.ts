import { describe, expect, it, vi } from 'vitest';

import { CanonicalMessageOpsService } from '@core/adapters/storage/postgres/services/canonical-message-ops-service.js';
import type { PostgresCanonicalMessageRepository } from '@core/adapters/storage/postgres/repositories/canonical-message-repository.postgres.js';

describe('CanonicalMessageOpsService', () => {
  it('does not pass an after boundary for an empty global cursor', async () => {
    const listInboundMessages = vi.fn().mockResolvedValue([]);
    const service = new CanonicalMessageOpsService({
      listInboundMessages,
    } as unknown as PostgresCanonicalMessageRepository);

    await service.getNewMessages(['tg:one'], '');

    expect(listInboundMessages).toHaveBeenCalledWith({
      jids: ['tg:one'],
      after: undefined,
      limit: 200,
    });
  });

  it('does not pass an after boundary for an empty group cursor', async () => {
    const listInboundMessages = vi.fn().mockResolvedValue([]);
    const service = new CanonicalMessageOpsService({
      listInboundMessages,
    } as unknown as PostgresCanonicalMessageRepository);

    await service.getMessagesSince('tg:one', '', 50, { threadId: null });

    expect(listInboundMessages).toHaveBeenCalledWith({
      jids: ['tg:one'],
      after: undefined,
      threadId: null,
      hasThreadFilter: true,
      limit: 50,
    });
  });
});
