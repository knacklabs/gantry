import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

import {
  attachmentExternalRefForIncomingAttachment,
  attachmentIdForIncomingAttachment,
  attachmentsJsonForMessage,
  existingAttachmentMetadataMaps,
  preservedMetadataForIncomingAttachment,
} from '@core/adapters/storage/postgres/repositories/canonical-message-attachments.postgres.js';

describe('canonical message attachment preservation', () => {
  it('drops a queued reclaimed provider ref while retaining fetch identity', () => {
    const providerFetch = {
      provider: 'slack',
      kind: 'file_id',
      id: 'provider-file-id',
    };

    expect(
      preservedMetadataForIncomingAttachment(
        {
          id: 'attachment-id',
          kind: 'file',
          storageRef: 'provider-attachments/reclaimed-report.pdf',
          provider_fetch: providerFetch,
        },
        'attachment-id',
        existingAttachmentMetadataMaps([]),
      ),
    ).toMatchObject({
      attachmentId: 'attachment-id',
      storageRef: null,
      providerFetchJson: providerFetch,
    });
  });

  it('carries forward only the matched row current provider ref', () => {
    const currentStorageRef = 'provider-attachments/current-report.pdf';
    const existing = existingAttachmentMetadataMaps([
      {
        id: 'attachment-id',
        externalRefJson: null,
        storageRef: currentStorageRef,
        fileName: 'report.pdf',
        providerFetchJson: {
          provider: 'slack',
          kind: 'file_id',
          id: 'provider-file-id',
        },
        deletedAt: null,
      },
    ]);

    expect(
      preservedMetadataForIncomingAttachment(
        {
          id: 'attachment-id',
          kind: 'file',
          storageRef: 'provider-attachments/reclaimed-report.pdf',
        },
        'attachment-id',
        existing,
      ).storageRef,
    ).toBe(currentStorageRef);
    expect(
      preservedMetadataForIncomingAttachment(
        {
          id: 'attachment-id',
          kind: 'file',
          storageRef: currentStorageRef,
        },
        'attachment-id',
        existing,
      ).storageRef,
    ).toBe(currentStorageRef);
  });

  it('synthesizes row ids from the strongest available stable identity', () => {
    const messageId = 'canonical:message';

    expect(
      attachmentIdForIncomingAttachment(
        messageId,
        {
          id: 'explicit-id',
          kind: 'file',
          externalId: 'external-id',
          provider_fetch: {
            provider: 'slack',
            kind: 'file_id',
            id: 'provider-id',
          },
        },
        3,
      ),
    ).toBe('explicit-id');
    expect(
      attachmentIdForIncomingAttachment(
        messageId,
        {
          kind: 'file',
          externalId: 'external-id',
          provider_fetch: {
            provider: 'slack',
            kind: 'file_id',
            id: 'provider-id',
          },
        },
        3,
      ),
    ).toBe('message-attachment:external:canonical%3Amessage:external-id');
    expect(
      attachmentIdForIncomingAttachment(
        messageId,
        {
          kind: 'file',
          provider_fetch: {
            provider: 'slack',
            kind: 'file_id',
            id: 'provider-id',
          },
        },
        3,
      ),
    ).toBe(
      'message-attachment:provider-fetch:canonical%3Amessage:slack:file_id:provider-id',
    );
    expect(
      attachmentIdForIncomingAttachment(messageId, { kind: 'file' }, 3),
    ).toBe('message-attachment:index:canonical%3Amessage:3');
    expect(
      attachmentExternalRefForIncomingAttachment({
        id: 'message-attachment:index:explicit',
        kind: 'file',
      }),
    ).toBeNull();
    expect(
      attachmentExternalRefForIncomingAttachment({ kind: 'file' }),
    ).toEqual({ kind: 'message_attachment_index' });
  });

  it('preserves metadata by provider attachment identity across redelivery', () => {
    const attachment = {
      kind: 'file' as const,
      provider_fetch: {
        provider: 'slack',
        kind: 'file_id',
        id: 'provider-file-id',
      },
    };
    const existing = existingAttachmentMetadataMaps([
      {
        id: attachmentIdForIncomingAttachment(
          'canonical-message-id',
          attachment,
          0,
        ),
        externalRefJson: null,
        storageRef: null,
        fileName: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
        providerFetchJson: {
          provider: 'slack',
          kind: 'file_id',
          id: 'provider-file-id',
        },
        deletedAt: '2026-07-30T12:00:00.000Z',
      },
    ]);

    expect(
      preservedMetadataForIncomingAttachment(
        attachment,
        attachmentIdForIncomingAttachment(
          'canonical-message-id',
          attachment,
          1,
        ),
        existing,
      ),
    ).toEqual({
      attachmentId:
        'message-attachment:provider-fetch:canonical-message-id:slack:file_id:provider-file-id',
      externalRefJson: null,
      storageRef: null,
      fileName: 'report.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
      providerFetchJson: {
        provider: 'slack',
        kind: 'file_id',
        id: 'provider-file-id',
      },
      deletedAt: '2026-07-30T12:00:00.000Z',
    });
  });

  it('preserves both attachment identities when redeliveries omit one at a time', () => {
    const messageId = 'canonical-message-id';
    const externalId = 'F';
    const providerFetch = {
      provider: 'slack',
      kind: 'file_id',
      id: 'P',
    };
    const externalRefJson = {
      kind: 'message_attachment',
      value: externalId,
    };
    const stored = existingAttachmentMetadataMaps([
      {
        id: 'attachment-id',
        externalRefJson,
        storageRef: 'attachments/report.pdf',
        fileName: null,
        providerFetchJson: providerFetch,
        deletedAt: '2026-07-30T12:00:00.000Z',
      },
    ]);

    const providerOnly = preservedMetadataForIncomingAttachment(
      { kind: 'file', provider_fetch: providerFetch },
      attachmentIdForIncomingAttachment(
        messageId,
        { kind: 'file', provider_fetch: providerFetch },
        0,
      ),
      stored,
    );
    const afterProviderOnly = existingAttachmentMetadataMaps([
      {
        id: providerOnly.attachmentId,
        externalRefJson: providerOnly.externalRefJson,
        storageRef: providerOnly.storageRef,
        fileName: providerOnly.fileName,
        providerFetchJson: providerOnly.providerFetchJson,
        deletedAt: providerOnly.deletedAt,
      },
    ]);
    const externalOnly = preservedMetadataForIncomingAttachment(
      { kind: 'file', externalId },
      attachmentIdForIncomingAttachment(
        messageId,
        { kind: 'file', externalId },
        0,
      ),
      afterProviderOnly,
    );

    expect({ providerOnly, externalOnly }).toEqual({
      providerOnly: {
        attachmentId: 'attachment-id',
        externalRefJson,
        storageRef: 'attachments/report.pdf',
        fileName: null,
        providerFetchJson: providerFetch,
        deletedAt: '2026-07-30T12:00:00.000Z',
      },
      externalOnly: {
        attachmentId: 'attachment-id',
        externalRefJson,
        storageRef: 'attachments/report.pdf',
        fileName: null,
        providerFetchJson: providerFetch,
        deletedAt: '2026-07-30T12:00:00.000Z',
      },
    });
  });

  it('keeps metadata paired with external identity when ID-less attachments reorder', () => {
    const messageId = 'canonical-message-id';
    const fileA = { kind: 'file' as const, externalId: 'provider-file-a' };
    const fileB = { kind: 'file' as const, externalId: 'provider-file-b' };
    const existing = existingAttachmentMetadataMaps([
      {
        id: attachmentIdForIncomingAttachment(messageId, fileA, 0),
        externalRefJson: {
          kind: 'message_attachment',
          value: 'provider-file-a',
        },
        storageRef: 'attachments/file-a.pdf',
        fileName: 'file-a.pdf',
        providerFetchJson: {
          provider: 'slack',
          kind: 'file_id',
          id: 'provider-file-a',
        },
        deletedAt: '2026-07-30T12:00:00.000Z',
      },
      {
        id: attachmentIdForIncomingAttachment(messageId, fileB, 1),
        externalRefJson: {
          kind: 'message_attachment',
          value: 'provider-file-b',
        },
        storageRef: 'attachments/file-b.pdf',
        fileName: 'file-b.pdf',
        providerFetchJson: {
          provider: 'slack',
          kind: 'file_id',
          id: 'provider-file-b',
        },
        deletedAt: null,
      },
    ]);

    expect(
      [fileB, fileA].map((attachment, index) => {
        const attachmentId = attachmentIdForIncomingAttachment(
          messageId,
          attachment,
          index,
        );
        return {
          attachmentId,
          metadata: preservedMetadataForIncomingAttachment(
            attachment,
            attachmentId,
            existing,
          ),
        };
      }),
    ).toEqual([
      {
        attachmentId:
          'message-attachment:external:canonical-message-id:provider-file-b',
        metadata: {
          attachmentId:
            'message-attachment:external:canonical-message-id:provider-file-b',
          externalRefJson: {
            kind: 'message_attachment',
            value: 'provider-file-b',
          },
          storageRef: 'attachments/file-b.pdf',
          fileName: 'file-b.pdf',
          providerFetchJson: {
            provider: 'slack',
            kind: 'file_id',
            id: 'provider-file-b',
          },
          deletedAt: null,
        },
      },
      {
        attachmentId:
          'message-attachment:external:canonical-message-id:provider-file-a',
        metadata: {
          attachmentId:
            'message-attachment:external:canonical-message-id:provider-file-a',
          externalRefJson: {
            kind: 'message_attachment',
            value: 'provider-file-a',
          },
          storageRef: 'attachments/file-a.pdf',
          fileName: 'file-a.pdf',
          providerFetchJson: {
            provider: 'slack',
            kind: 'file_id',
            id: 'provider-file-a',
          },
          deletedAt: '2026-07-30T12:00:00.000Z',
        },
      },
    ]);
  });

  it('rejects an ID match when external attachment identity conflicts', () => {
    const existing = existingAttachmentMetadataMaps([
      {
        id: 'attachment-id',
        externalRefJson: {
          kind: 'message_attachment',
          value: 'old-provider-file-id',
        },
        storageRef: 'attachments/old-file.pdf',
        fileName: 'old-file.pdf',
        providerFetchJson: {
          provider: 'slack',
          kind: 'file_id',
          id: 'old-provider-file-id',
        },
        deletedAt: '2026-07-30T12:00:00.000Z',
      },
    ]);

    expect(
      preservedMetadataForIncomingAttachment(
        {
          id: 'attachment-id',
          kind: 'file',
          externalId: 'new-provider-file-id',
          storageRef: 'attachments/new-file.pdf',
        },
        'attachment-id',
        existing,
      ),
    ).toEqual({
      attachmentId: 'attachment-id',
      externalRefJson: {
        kind: 'message_attachment',
        value: 'new-provider-file-id',
      },
      storageRef: 'attachments/new-file.pdf',
      fileName: null,
      providerFetchJson: null,
      deletedAt: null,
    });
  });

  it('merges provider fetch extensions when provider identity matches', () => {
    const existing = existingAttachmentMetadataMaps([
      {
        id: 'attachment-id',
        externalRefJson: null,
        storageRef: null,
        fileName: null,
        providerFetchJson: {
          provider: 'slack',
          kind: 'file_id',
          id: 'provider-file-id',
          team_id: 'T123',
        },
        deletedAt: null,
      },
    ]);

    expect(
      preservedMetadataForIncomingAttachment(
        {
          id: 'attachment-id',
          kind: 'file',
          provider_fetch: {
            provider: 'slack',
            kind: 'file_id',
            id: 'provider-file-id',
          },
        },
        'attachment-id',
        existing,
      ).providerFetchJson,
    ).toEqual({
      provider: 'slack',
      kind: 'file_id',
      id: 'provider-file-id',
      team_id: 'T123',
    });
  });

  it('rejects an ID match when provider fetch identity conflicts', () => {
    const existing = existingAttachmentMetadataMaps([
      {
        id: 'attachment-id',
        externalRefJson: null,
        storageRef: 'attachments/old-file.pdf',
        fileName: 'old-file.pdf',
        providerFetchJson: {
          provider: 'slack',
          kind: 'file_id',
          id: 'old-provider-file-id',
          team_id: 'T123',
        },
        deletedAt: '2026-07-30T12:00:00.000Z',
      },
    ]);
    const incoming = {
      provider: 'slack',
      kind: 'file_id',
      id: 'new-provider-file-id',
    };

    expect(
      preservedMetadataForIncomingAttachment(
        {
          id: 'attachment-id',
          kind: 'file',
          provider_fetch: incoming,
        },
        'attachment-id',
        existing,
      ),
    ).toEqual({
      attachmentId: 'attachment-id',
      externalRefJson: null,
      storageRef: null,
      fileName: null,
      providerFetchJson: incoming,
      deletedAt: null,
    });
  });

  it('keeps the matched row handle when an explicit provider id appears or disappears', () => {
    const externalId = 'F1';
    const synthesizedHandle =
      'message-attachment:external:canonical-message-id:F1';
    const synthesizedExisting = existingAttachmentMetadataMaps([
      {
        id: synthesizedHandle,
        externalRefJson: {
          kind: 'message_attachment',
          value: externalId,
        },
        storageRef: 'attachments/report.pdf',
        fileName: 'report.pdf',
        providerFetchJson: null,
        deletedAt: null,
      },
    ]);

    expect(
      preservedMetadataForIncomingAttachment(
        {
          id: 'provider-id',
          kind: 'file',
          externalId,
          provider_fetch: {
            provider: 'slack',
            kind: 'file_id',
            id: externalId,
          },
        },
        'provider-id',
        synthesizedExisting,
      ),
    ).toMatchObject({
      attachmentId: synthesizedHandle,
      storageRef: 'attachments/report.pdf',
      fileName: 'report.pdf',
      providerFetchJson: {
        provider: 'slack',
        kind: 'file_id',
        id: externalId,
      },
    });

    const explicitExisting = existingAttachmentMetadataMaps([
      {
        id: 'provider-id',
        externalRefJson: {
          kind: 'message_attachment',
          value: externalId,
        },
        storageRef: 'attachments/report.pdf',
        fileName: 'report.pdf',
        providerFetchJson: {
          provider: 'slack',
          kind: 'file_id',
          id: externalId,
        },
        deletedAt: null,
      },
    ]);

    expect(
      preservedMetadataForIncomingAttachment(
        { kind: 'file', externalId },
        synthesizedHandle,
        explicitExisting,
      ),
    ).toMatchObject({
      attachmentId: 'provider-id',
      storageRef: 'attachments/report.pdf',
      fileName: 'report.pdf',
    });
  });

  it('renders identified legacy row handles and suppresses identity-less ones', () => {
    const query = new PgDialect().sqlToQuery(
      attachmentsJsonForMessage('canonical-message-id'),
    ).sql;

    expect(query).toMatch(
      /jsonb_strip_nulls\(\s*jsonb_build_object\([\s\S]*?'deleted_at'[\s\S]*?\)\s*\)\s*\|\|\s*CASE[\s\S]*?jsonb_build_object\(\s*'provider_fetch'/,
    );
    expect(query).toMatch(
      /left\([\s\S]*?attachment_row\.id[\s\S]*?'message-attachment:' \|\| attachment_row\.message_id \|\| ':'[\s\S]*?~ '\^\[0-9\]\+\$'[\s\S]*?attachment_row\.external_id IS NULL[\s\S]*?attachment_row\.provider_fetch_json IS NULL/,
    );
  });
});
