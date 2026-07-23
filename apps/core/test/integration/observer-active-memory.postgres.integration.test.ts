import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import { listObserverActiveMemoryValues } from '@core/memory/app-memory-item-queries.js';
import { hasExactActiveMemoryMatch } from '@core/memory/observer-active-memory.js';
import { conversationIdForChannel } from '@core/memory/app-memory-service-record-mappers.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const APP_ID = 'observer-active-memory-app';
const NOW = '2026-07-22T08:00:00.000Z';
const SAME_CONVERSATION = conversationIdForChannel(
  'sl:C111',
)! as `conversation:${string}`;
const OTHER_CONVERSATION = conversationIdForChannel(
  'sl:C222',
)! as `conversation:${string}`;

maybeDescribe('observer active-memory dedup', () => {
  let runtime: PostgresIntegrationRuntime;
  const memory = {
    listActiveValues: (input: {
      appId: string;
      subject: `conversation:${string}` | 'observer:app';
    }) =>
      listObserverActiveMemoryValues({
        db: runtime.service.db,
        ...input,
      }),
  };

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'observer_active_memory',
    });
    await runtime.repositories.apps.saveApp({
      id: APP_ID as never,
      slug: APP_ID,
      name: 'Observer active memory test',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await runtime.service.db.insert(pgSchema.memoryItemsPostgres).values([
      {
        id: 'observer-memory-same',
        appId: APP_ID,
        agentId: 'agent-1',
        subjectType: 'conversation',
        subjectId: 'sl:C111',
        conversationId: SAME_CONVERSATION,
        kind: 'fact',
        key: 'same-conversation',
        valueJson: { value: '  Ｓｈｉｐ—the REPORT!!! ' },
        sourceRefJson: {},
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'observer-memory-other',
        appId: APP_ID,
        agentId: 'agent-1',
        subjectType: 'conversation',
        subjectId: 'sl:C222',
        conversationId: OTHER_CONVERSATION,
        kind: 'fact',
        key: 'other-conversation',
        valueJson: { value: 'Other conversation fact' },
        sourceRefJson: {},
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'observer-memory-common',
        appId: APP_ID,
        agentId: 'agent-1',
        subjectType: 'common',
        subjectId: 'common',
        kind: 'fact',
        key: 'common',
        valueJson: { value: 'Shared app fact' },
        sourceRefJson: {},
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'observer-memory-inactive',
        appId: APP_ID,
        agentId: 'agent-1',
        subjectType: 'conversation',
        subjectId: 'sl:C111',
        conversationId: SAME_CONVERSATION,
        kind: 'fact',
        key: 'inactive',
        valueJson: { value: 'Inactive fact' },
        sourceRefJson: {},
        status: 'superseded',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  it('matches canonicalized active values only in the source conversation', async () => {
    await expect(
      hasExactActiveMemoryMatch({
        memory,
        appId: APP_ID,
        subject: SAME_CONVERSATION,
        candidateText: 'ship the report',
      }),
    ).resolves.toBe(true);
    await expect(
      hasExactActiveMemoryMatch({
        memory,
        appId: APP_ID,
        subject: SAME_CONVERSATION,
        candidateText: 'Other conversation fact',
      }),
    ).resolves.toBe(false);
    await expect(
      hasExactActiveMemoryMatch({
        memory,
        appId: APP_ID,
        subject: SAME_CONVERSATION,
        candidateText: 'Inactive fact',
      }),
    ).resolves.toBe(false);
  });

  it('uses only active common memory for the observer:app fallback', async () => {
    await expect(
      hasExactActiveMemoryMatch({
        memory,
        appId: APP_ID,
        subject: 'observer:app',
        candidateText: 'shared—app fact',
      }),
    ).resolves.toBe(true);
    await expect(
      hasExactActiveMemoryMatch({
        memory,
        appId: APP_ID,
        subject: 'observer:app',
        candidateText: 'Other conversation fact',
      }),
    ).resolves.toBe(false);
  });
});
