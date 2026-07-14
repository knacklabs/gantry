import { describe, expect, it } from 'vitest';

import '@core/channels/register-builtins.js';
import { resolveOutboundDeliveryDestination } from '@core/adapters/storage/postgres/repositories/outbound-delivery-repository.postgres.destinations.js';

class FakeSelectBuilder {
  constructor(private readonly rows: unknown[]) {}

  from() {
    return this;
  }

  innerJoin() {
    return this;
  }

  where() {
    return this;
  }

  async limit(): Promise<unknown[]> {
    return this.rows;
  }
}

class FakeDb {
  constructor(
    private readonly conversationRows: unknown[],
    private readonly threadedRows: unknown[] = [],
  ) {}

  select(selection: Record<string, unknown>) {
    const isThreadedQuery = Object.hasOwn(selection, 'threadId');
    return new FakeSelectBuilder(
      isThreadedQuery ? this.threadedRows : this.conversationRows,
    );
  }
}

describe('resolveOutboundDeliveryDestination', () => {
  it('fails closed when external ref has mismatched explicit provider prefix', async () => {
    const db = new FakeDb([
      {
        conversationId: 'conversation:slack_default:C123',
        providerAccountId: 'slack_default',
        conversationExternalRefJson: JSON.stringify({ jid: 'tg:-100123' }),
        providerId: 'slack',
      },
    ]);

    const resolved = await resolveOutboundDeliveryDestination(db as never, {
      appId: 'app:default' as never,
      conversationId: 'conversation:slack_default:C123' as never,
    });

    expect(resolved).toBeNull();
  });

  it('accepts explicit provider-prefixed ids when they match the conversation provider', async () => {
    const db = new FakeDb([
      {
        conversationId: 'conversation:slack_default:C123',
        providerAccountId: 'slack_default',
        conversationExternalRefJson: JSON.stringify({ jid: 'sl:C123' }),
        providerId: 'slack',
      },
    ]);

    const resolved = await resolveOutboundDeliveryDestination(db as never, {
      appId: 'app:default' as never,
      conversationId: 'conversation:slack_default:C123' as never,
    });

    expect(resolved).toEqual({
      conversationJid: 'sl:C123',
      providerId: 'slack',
      providerAccountId: 'slack_default',
    });
  });

  it('prefixes raw external ids with the canonical provider prefix', async () => {
    const db = new FakeDb([
      {
        conversationId: 'conversation:slack_default:C123',
        providerAccountId: 'slack_default',
        conversationExternalRefJson: JSON.stringify({ jid: 'C123' }),
        providerId: 'slack',
      },
    ]);

    const resolved = await resolveOutboundDeliveryDestination(db as never, {
      appId: 'app:default' as never,
      conversationId: 'conversation:slack_default:C123' as never,
    });

    expect(resolved).toEqual({
      conversationJid: 'sl:C123',
      providerId: 'slack',
      providerAccountId: 'slack_default',
    });
  });

  it('resolves control graph conversations to app session chat JIDs', async () => {
    const db = new FakeDb([
      {
        conversationId: 'control:app-one:conversation:conv-1',
        providerAccountId: 'control:app-one',
        conversationExternalRefJson: JSON.stringify({
          externalConversationId: 'conv-1',
          externalConversationRef: 'app:app-one:conv-1',
        }),
        providerId: 'app',
      },
    ]);

    const resolved = await resolveOutboundDeliveryDestination(db as never, {
      appId: 'app-one' as never,
      conversationId: 'control:app-one:conversation:conv-1' as never,
    });

    expect(resolved).toEqual({
      conversationJid: 'app:app-one:conv-1',
      providerId: 'app',
      providerAccountId: 'control:app-one',
    });
  });
});
