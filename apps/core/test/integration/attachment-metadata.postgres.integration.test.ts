import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { PostgresCanonicalMessageRepository } from '@core/adapters/storage/postgres/repositories/canonical-message-repository.postgres.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import { CanonicalMessageOpsService } from '@core/adapters/storage/postgres/services/canonical-message-ops-service.js';
import type { NewMessage } from '@core/domain/types.js';
import { formatConversationContextMessages } from '@core/messaging/router.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('attachment metadata (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let messages: CanonicalMessageOpsService;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'attachment_metadata',
    });
    messages = new CanonicalMessageOpsService(
      new PostgresCanonicalMessageRepository(runtime.service.db),
    );
  });

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('round-trips attachment metadata and preserves it across redelivery', async () => {
    const message: NewMessage = {
      id: 'provider-message-1',
      chat_jid: 'sl:C_FILE_METADATA',
      provider: 'slack',
      providerAccountId: 'slack_default',
      sender: 'U_FILE_METADATA',
      sender_name: 'File Owner',
      content: 'report attached',
      timestamp: '2026-07-30T12:00:00.000Z',
      external_message_id: 'provider-message-1',
      attachments: [
        {
          id: 'slack-file:F_FILE_METADATA',
          kind: 'file',
          contentType: 'application/pdf',
          sizeBytes: 2048,
          externalId: 'F_FILE_METADATA',
          storageRef: 'attachments/report.pdf',
          file_name: 'report.pdf',
          provider_fetch: {
            provider: 'slack',
            kind: 'file_id',
            id: 'F_FILE_METADATA',
            team_id: null,
            extensions: {
              nullable_extension: null,
              nested: { nullable_value: null },
            },
          },
          deleted_at: '2026-07-30T12:05:00.000Z',
        },
      ],
    };

    await messages.storeMessage(message);

    const initial = await messages.getMessagesSince(message.chat_jid, '');
    expect(initial).toHaveLength(1);
    expect(initial[0]?.attachments).toEqual([
      {
        id: 'slack-file:F_FILE_METADATA',
        kind: 'file',
        contentType: 'application/pdf',
        sizeBytes: 2048,
        externalId: 'F_FILE_METADATA',
        storageRef: 'attachments/report.pdf',
        file_name: 'report.pdf',
        provider_fetch: {
          provider: 'slack',
          kind: 'file_id',
          id: 'F_FILE_METADATA',
          team_id: null,
          extensions: {
            nullable_extension: null,
            nested: { nullable_value: null },
          },
        },
        deleted_at: '2026-07-30T12:05:00.000Z',
      },
    ]);

    await messages.storeMessage({
      ...message,
      content: 'report redelivered',
      attachments: [
        {
          id: 'slack-file:F_FILE_METADATA',
          kind: 'file',
          contentType: 'application/pdf',
          sizeBytes: 2048,
          externalId: 'F_FILE_METADATA',
        },
      ],
    });

    const redelivered = await messages.getMessagesSince(message.chat_jid, '');
    expect(redelivered).toHaveLength(1);
    expect(redelivered[0]?.attachments).toEqual([
      {
        id: 'slack-file:F_FILE_METADATA',
        kind: 'file',
        contentType: 'application/pdf',
        sizeBytes: 2048,
        externalId: 'F_FILE_METADATA',
        storageRef: 'attachments/report.pdf',
        file_name: 'report.pdf',
        provider_fetch: {
          provider: 'slack',
          kind: 'file_id',
          id: 'F_FILE_METADATA',
          team_id: null,
          extensions: {
            nullable_extension: null,
            nested: { nullable_value: null },
          },
        },
        deleted_at: '2026-07-30T12:05:00.000Z',
      },
    ]);
  });

  it('keeps a matched attachment handle across explicit-id transitions', async () => {
    const message: NewMessage = {
      id: 'provider-message-handle-transition',
      chat_jid: 'sl:C_FILE_METADATA_HANDLE_TRANSITION',
      provider: 'slack',
      providerAccountId: 'slack_default',
      sender: 'U_FILE_METADATA',
      sender_name: 'File Owner',
      content: 'report attached',
      timestamp: '2026-07-30T12:15:00.000Z',
      external_message_id: 'provider-message-handle-transition',
      attachments: [
        {
          kind: 'file',
          externalId: 'F_HANDLE_TRANSITION',
          storageRef: 'attachments/report.pdf',
          file_name: 'report.pdf',
        },
      ],
    };

    await messages.storeMessage(message);
    const initial = await messages.getMessagesSince(message.chat_jid, '');
    const synthesizedHandle = initial[0]!.attachments![0]!.id!;

    await messages.storeMessage({
      ...message,
      attachments: [
        {
          id: 'provider-id',
          kind: 'file',
          externalId: 'F_HANDLE_TRANSITION',
          provider_fetch: {
            provider: 'slack',
            kind: 'file_id',
            id: 'F_HANDLE_TRANSITION',
          },
        },
      ],
    });
    const enriched = await messages.getMessagesSince(message.chat_jid, '');
    expect(enriched[0]?.attachments).toEqual([
      {
        id: synthesizedHandle,
        kind: 'file',
        externalId: 'F_HANDLE_TRANSITION',
        storageRef: 'attachments/report.pdf',
        file_name: 'report.pdf',
        provider_fetch: {
          provider: 'slack',
          kind: 'file_id',
          id: 'F_HANDLE_TRANSITION',
        },
      },
    ]);

    await messages.storeMessage({
      ...message,
      attachments: [
        {
          kind: 'file',
          externalId: 'F_HANDLE_TRANSITION',
        },
      ],
    });
    const reduced = await messages.getMessagesSince(message.chat_jid, '');
    expect(reduced[0]?.attachments?.[0]?.id).toBe(synthesizedHandle);
  });

  it('does not publish an array-index row id as a durable handle', async () => {
    const message: NewMessage = {
      id: 'provider-message-identityless',
      chat_jid: 'sl:C_FILE_METADATA_IDENTITYLESS',
      provider: 'slack',
      providerAccountId: 'slack_default',
      sender: 'U_FILE_METADATA',
      sender_name: 'File Owner',
      content: 'identity-less report attached',
      timestamp: '2026-07-30T12:30:00.000Z',
      external_message_id: 'provider-message-identityless',
      attachments: [{ kind: 'file', file_name: 'identity-less.pdf' }],
    };

    await messages.storeMessage(message);

    const [attachmentRow] = await runtime.service.db
      .select({
        id: pgSchema.messageAttachmentsPostgres.id,
        messageId: pgSchema.messageAttachmentsPostgres.messageId,
      })
      .from(pgSchema.messageAttachmentsPostgres)
      .where(
        eq(pgSchema.messageAttachmentsPostgres.fileName, 'identity-less.pdf'),
      );
    expect(attachmentRow).toBeDefined();
    await runtime.service.db
      .update(pgSchema.messageAttachmentsPostgres)
      .set({
        id: `message-attachment:${attachmentRow!.messageId}:0`,
        externalRefJson: null,
      })
      .where(eq(pgSchema.messageAttachmentsPostgres.id, attachmentRow!.id));

    const stored = await messages.getMessagesSince(message.chat_jid, '');
    expect(stored[0]?.attachments).toEqual([
      { kind: 'file', file_name: 'identity-less.pdf' },
    ]);
    expect(
      formatConversationContextMessages(
        {
          recentChannelContext: [],
          activeThreadContext: [],
          currentMessages: stored,
        },
        'UTC',
      ),
    ).not.toContain('gantry_attachment=');
  });

  it('preserves attachment metadata by external identity when ID-less attachments reorder', async () => {
    const message: NewMessage = {
      id: 'provider-message-reordered',
      chat_jid: 'sl:C_FILE_METADATA_REORDERED',
      provider: 'slack',
      providerAccountId: 'slack_default',
      sender: 'U_FILE_METADATA',
      sender_name: 'File Owner',
      content: 'two reports attached',
      timestamp: '2026-07-30T13:00:00.000Z',
      external_message_id: 'provider-message-reordered',
      attachments: [
        {
          kind: 'file',
          externalId: 'F_FILE_A',
          storageRef: 'attachments/file-a.pdf',
          file_name: 'file-a.pdf',
          provider_fetch: {
            provider: 'slack',
            kind: 'file_id',
            id: 'F_FILE_A',
          },
          deleted_at: '2026-07-30T13:05:00.000Z',
        },
        {
          kind: 'file',
          externalId: 'F_FILE_B',
          storageRef: 'attachments/file-b.pdf',
          file_name: 'file-b.pdf',
          provider_fetch: {
            provider: 'slack',
            kind: 'file_id',
            id: 'F_FILE_B',
          },
        },
      ],
    };

    await messages.storeMessage(message);
    const initial = await messages.getMessagesSince(message.chat_jid, '');
    const initialFileA = initial[0]?.attachments?.find(
      (attachment) => attachment.externalId === 'F_FILE_A',
    );
    expect(initialFileA?.id).toBeTruthy();
    const fileAHandle = initialFileA!.id!;
    expect(
      formatConversationContextMessages(
        {
          recentChannelContext: [],
          activeThreadContext: [],
          currentMessages: [
            {
              ...initial[0]!,
              attachments: [initialFileA!],
            },
          ],
        },
        'UTC',
      ),
    ).toContain(`gantry_attachment="${fileAHandle}"`);

    await messages.storeMessage({
      ...message,
      content: 'two reports redelivered in a different order',
      attachments: [
        { kind: 'file', externalId: 'F_FILE_B' },
        { kind: 'file', externalId: 'F_FILE_A' },
      ],
    });

    const redelivered = await messages.getMessagesSince(message.chat_jid, '');
    const redeliveredFileA = redelivered[0]?.attachments?.find(
      (attachment) => attachment.externalId === 'F_FILE_A',
    );
    expect(redelivered).toHaveLength(1);
    expect(redeliveredFileA).toEqual({
      id: fileAHandle,
      kind: 'file',
      externalId: 'F_FILE_A',
      storageRef: 'attachments/file-a.pdf',
      file_name: 'file-a.pdf',
      provider_fetch: {
        provider: 'slack',
        kind: 'file_id',
        id: 'F_FILE_A',
      },
      deleted_at: '2026-07-30T13:05:00.000Z',
    });
    expect(redelivered[0]?.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'file',
          externalId: 'F_FILE_B',
          storageRef: 'attachments/file-b.pdf',
          file_name: 'file-b.pdf',
          provider_fetch: {
            provider: 'slack',
            kind: 'file_id',
            id: 'F_FILE_B',
          },
        }),
      ]),
    );
    expect(
      formatConversationContextMessages(
        {
          recentChannelContext: [],
          activeThreadContext: [],
          currentMessages: [
            {
              ...redelivered[0]!,
              attachments: [redeliveredFileA!],
            },
          ],
        },
        'UTC',
      ),
    ).toContain(`gantry_attachment="${fileAHandle}"`);
  });
});
