import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresCanonicalGraphRepository } from '@core/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
import { PostgresTeamsConversationRouteStore } from '@core/channels/teams/conversation-route-store.postgres.js';
import type { TeamsConversationRoute } from '@core/channels/teams/conversation-route-store.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

// Requires the shared disposable Postgres integration database.
const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('durable Teams conversation routing (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'teams_conversation_routing',
    });
  }, 60_000);

  afterAll(async () => {
    if (runtime) await runtime.cleanup();
  });

  it('remembers refreshed routes for sibling accounts across canonical saves and reloads without crossing connections', async () => {
    const conversationJid = 'teams:19:operations@thread.tacv2';
    const threadedJid = `${conversationJid};messageid=root-message`;
    const siblingAccounts = ['teams_operations', 'teams_operations_alias'];
    const otherAccount = 'teams_other_connection';
    const graph = new PostgresCanonicalGraphRepository(runtime.service.db);
    const store = new PostgresTeamsConversationRouteStore(runtime.service.db);
    const route: TeamsConversationRoute = {
      conversationJid: threadedJid,
      serviceUrl: 'https://smba.trafficmanager.net/region-one/',
      tenantId: 'tenant-one',
      botId: 'bot-one',
      channelId: 'msteams',
      conversationType: 'channel',
    };

    await graph.ensureApp();
    const initial = await runtime.service.pool.query(
      'SELECT id FROM conversations WHERE provider_account_id = ANY($1::text[])',
      [siblingAccounts],
    );
    expect(initial.rows).toEqual([]);
    await expect(
      store.get({ providerAccountId: siblingAccounts[0]!, conversationJid }),
    ).resolves.toBeNull();

    await store.upsertForProviderAccounts({
      providerAccountIds: siblingAccounts,
      route,
    });
    for (const providerAccountId of siblingAccounts) {
      await expect(
        store.get({ providerAccountId, conversationJid }),
      ).resolves.toEqual({ ...route, conversationJid });
    }

    const refreshedRoute: TeamsConversationRoute = {
      conversationJid,
      serviceUrl: 'https://smba.trafficmanager.net/region-two/',
      tenantId: 'tenant-two',
      botId: 'bot-two',
      channelId: 'refreshed-channel',
      conversationType: null,
    };
    await store.upsertForProviderAccounts({
      providerAccountIds: siblingAccounts,
      route: refreshedRoute,
    });

    // Saving ordinary conversation metadata after route capture must retain the
    // transport fields while canonical identity stays owned by the graph.
    for (const providerAccountId of siblingAccounts) {
      await graph.ensureConversation(conversationJid, {
        providerAccountId,
        channel: 'teams',
        name: 'Operations',
        isGroup: true,
      });
    }
    const saved = await runtime.service.pool.query<{
      id: string;
      providerAccountId: string;
      externalRefJson: string;
      title: string;
    }>(
      `SELECT id, provider_account_id AS "providerAccountId",
        external_ref_json AS "externalRefJson", title
       FROM conversations WHERE provider_account_id = ANY($1::text[])
       ORDER BY provider_account_id`,
      [siblingAccounts],
    );
    expect(saved.rows).toHaveLength(2);
    for (const row of saved.rows) {
      expect(row.id).toBe(
        `conversation:${row.providerAccountId}:${conversationJid}`,
      );
      expect(row.title).toBe('Operations');
      expect(JSON.parse(row.externalRefJson)).toMatchObject({
        kind: 'conversation',
        value: '19:operations@thread.tacv2',
        jid: conversationJid,
        externalConversationId: '19:operations@thread.tacv2',
        providerId: 'teams',
        providerAccountId: row.providerAccountId,
        serviceUrl: refreshedRoute.serviceUrl,
        tenantId: refreshedRoute.tenantId,
        botId: refreshedRoute.botId,
        channelId: refreshedRoute.channelId,
        conversationType: null,
      });
    }

    const reloaded = new PostgresTeamsConversationRouteStore(
      runtime.service.db,
    );
    for (const providerAccountId of siblingAccounts) {
      await expect(
        reloaded.get({ providerAccountId, conversationJid: threadedJid }),
      ).resolves.toEqual(refreshedRoute);
    }
    await expect(
      reloaded.get({ providerAccountId: otherAccount, conversationJid }),
    ).resolves.toBeNull();
    await expect(
      reloaded.get({
        providerAccountId: siblingAccounts[0]!,
        conversationJid: 'teams:19:unseen@thread.tacv2',
      }),
    ).resolves.toBeNull();

    const otherRoute: TeamsConversationRoute = {
      ...route,
      conversationJid,
      botId: 'independent-bot',
      tenantId: 'independent-tenant',
      serviceUrl: 'https://smba.trafficmanager.net/independent/',
    };
    await reloaded.upsertForProviderAccounts({
      providerAccountIds: [otherAccount],
      route: otherRoute,
    });
    await expect(
      reloaded.get({ providerAccountId: otherAccount, conversationJid }),
    ).resolves.toEqual(otherRoute);
    for (const providerAccountId of siblingAccounts) {
      await expect(
        reloaded.get({ providerAccountId, conversationJid }),
      ).resolves.toEqual(refreshedRoute);
    }
  });
});
