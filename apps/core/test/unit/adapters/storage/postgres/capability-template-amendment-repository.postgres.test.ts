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
    decidedBy: status === 'pending' ? null : 'person:approver',
    decisionReason: status === 'pending' ? null : 'reviewed',
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    decidedAt: status === 'pending' ? null : '2026-08-11T00:01:00.000Z',
  };
}

describe('PostgresCapabilityTemplateAmendmentRepository', () => {
  it('atomically creates one pending row for the canonical proposal key', async () => {
    const row = proposalRow();
    const returning = vi.fn(async () => [row]);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values }));
    const repository = new PostgresCapabilityTemplateAmendmentRepository({
      insert,
    } as never);

    await expect(
      repository.claimPending({
        id: row.id,
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
      }),
    ).resolves.toMatchObject({
      created: true,
      proposal: { status: 'pending' },
    });

    expect(onConflictDoNothing).toHaveBeenCalledWith({
      target: [
        pgSchema.capabilityTemplateAmendmentProposalsPostgres.appId,
        pgSchema.capabilityTemplateAmendmentProposalsPostgres.canonicalKey,
      ],
    });
  });

  it('returns the existing terminal denial when the canonical key conflicts', async () => {
    const row = proposalRow('denied');
    const insertReturning = vi.fn(async () => []);
    const onConflictDoNothing = vi.fn(() => ({ returning: insertReturning }));
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values }));
    const limit = vi.fn(async () => [row]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const repository = new PostgresCapabilityTemplateAmendmentRepository({
      insert,
      select,
    } as never);

    await expect(
      repository.claimPending({
        id: 'new-id',
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
      }),
    ).resolves.toMatchObject({
      created: false,
      proposal: { id: row.id, status: 'denied' },
    });
  });
});
