import { describe, expect, it, vi } from 'vitest';

import { PostgresCapabilityTemplateAmendmentRepository } from '@core/adapters/storage/postgres/repositories/capability-template-amendment-repository.postgres.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';

function proposalRow(status: 'pending' | 'approved' | 'denied' = 'pending') {
  return {
    id: 'capability-amendment-1',
    appId: 'app:test',
    agentId: 'agent:main_agent',
    capabilityId: 'google.sheets.read',
    canonicalKey: 'canonical-key',
    currentTemplates: ['/usr/local/bin/gog sheets get *'],
    proposedTemplates: ['/usr/local/bin/gog sheets get * *'],
    observedArgv: ['sheets', 'get', 'sheet-id', 'Sheet1!A:B'],
    reviewedSchemaHash: 'schema-hash',
    widening: false,
    status,
    requestedBy: 'main_agent',
    jobId: null,
    conversationJid: 'tg:team',
    threadId: null,
    decidedBy: status === 'pending' ? null : 'person:approver',
    decisionReason: status === 'pending' ? null : 'reviewed',
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    decidedAt: status === 'pending' ? null : '2026-08-11T00:01:00.000Z',
  };
}

// The claim runs in one transaction: existing canonical-key rows are locked
// (select ... for update), terminal dedupe is definition-scoped, and the
// pending-only partial unique index arbitrates concurrent first claims.
function transactionalDb(input: {
  existingRows: unknown[];
  insertedRow: unknown | null;
  onConflictDoNothing: ReturnType<typeof vi.fn>;
}) {
  const forUpdate = vi.fn(async () => input.existingRows);
  const orderBy = vi.fn(() => ({ for: forUpdate }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const returning = vi.fn(async () =>
    input.insertedRow ? [input.insertedRow] : [],
  );
  input.onConflictDoNothing.mockReturnValue({ returning });
  const values = vi.fn(() => ({
    onConflictDoNothing: input.onConflictDoNothing,
  }));
  const insert = vi.fn(() => ({ values }));
  const tx = { select, insert };
  return {
    transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
  };
}

function claimInput(row: ReturnType<typeof proposalRow>, id = row.id) {
  return {
    id,
    appId: row.appId,
    agentId: row.agentId,
    capabilityId: row.capabilityId,
    canonicalKey: row.canonicalKey,
    currentTemplates: row.currentTemplates,
    proposedTemplates: row.proposedTemplates,
    observedArgv: row.observedArgv,
    reviewedSchemaHash: row.reviewedSchemaHash,
    widening: row.widening,
    requestedBy: row.requestedBy,
    now: row.createdAt,
  };
}

describe('PostgresCapabilityTemplateAmendmentRepository', () => {
  it('atomically creates one pending row for the canonical proposal key', async () => {
    const row = proposalRow();
    const onConflictDoNothing = vi.fn();
    const db = transactionalDb({
      existingRows: [],
      insertedRow: row,
      onConflictDoNothing,
    });
    const repository = new PostgresCapabilityTemplateAmendmentRepository(
      db as never,
    );

    await expect(
      repository.claimPending(claimInput(row)),
    ).resolves.toMatchObject({
      created: true,
      proposal: { status: 'pending' },
    });

    expect(onConflictDoNothing).toHaveBeenCalledWith(
      expect.objectContaining({
        target: [
          pgSchema.capabilityTemplateAmendmentProposalsPostgres.appId,
          pgSchema.capabilityTemplateAmendmentProposalsPostgres.canonicalKey,
        ],
      }),
    );
  });

  it('returns the existing terminal denial for the same reviewed definition', async () => {
    const row = proposalRow('denied');
    const db = transactionalDb({
      existingRows: [row],
      insertedRow: null,
      onConflictDoNothing: vi.fn(),
    });
    const repository = new PostgresCapabilityTemplateAmendmentRepository(
      db as never,
    );

    await expect(
      repository.claimPending(claimInput(row, 'new-id')),
    ).resolves.toMatchObject({
      created: false,
      proposal: { id: row.id, status: 'denied' },
    });
  });

  it('a system-superseded row never blocks a fresh review', async () => {
    const superseded = {
      ...proposalRow('denied'),
      decidedBy: 'system:superseded',
    };
    const fresh = { ...proposalRow('pending'), id: 'new-id' };
    const db = transactionalDb({
      existingRows: [superseded],
      insertedRow: fresh,
      onConflictDoNothing: vi.fn(),
    });
    const repository = new PostgresCapabilityTemplateAmendmentRepository(
      db as never,
    );

    await expect(
      repository.claimPending(claimInput(proposalRow(), 'new-id')),
    ).resolves.toMatchObject({
      created: true,
      proposal: { id: 'new-id', status: 'pending' },
    });
  });
});
