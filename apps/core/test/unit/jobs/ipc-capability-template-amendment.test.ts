import { describe, expect, it, vi } from 'vitest';

import { startCapabilityTemplateAmendmentReview } from '@core/jobs/ipc-capability-template-amendment.js';
import type { CapabilityTemplateAmendmentRepository } from '@core/domain/ports/capability-template-amendments.js';

describe('capability template amendment approval', () => {
  it('records the resolved human principal with an approved amendment', async () => {
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const amendSemanticCapabilityCommandTemplates = vi.fn(async () => ({
      status: 'amended' as const,
      historyId: 'history:one',
      auditEventId: 'audit:one',
    }));
    const repository = {
      amendSemanticCapabilityCommandTemplates,
      markDecision: vi.fn(),
    } as unknown as CapabilityTemplateAmendmentRepository;

    startCapabilityTemplateAmendmentReview({
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          kind: 'decision' as const,
          decision: {
            approved: true,
            mode: 'allow_once' as const,
            decidedBy: 'U123',
            source: 'human_once' as const,
            decisionClassification: 'user_temporary' as const,
          },
        })),
        resolveControlApproverPrincipal: vi.fn(async () => ({
          kind: 'human' as const,
          personId: 'person:owner',
          aliasId: 'alias:owner',
        })),
        sendMessage: vi.fn(async () => finish()),
      } as never,
      repository,
      review: {
        proposal: {
          id: 'proposal:one',
          appId: 'app:one',
          agentId: 'agent:one',
          capabilityId: 'gog.sheets.read',
          canonicalKey: 'canonical:one',
          currentTemplates: ['/usr/bin/gog sheets get *'],
          proposedTemplates: ['/usr/bin/gog sheets get * *'],
          observedArgv: ['sheets', 'get', 'sheet'],
          reviewedSchemaHash: 'schema:one',
          widening: true,
          status: 'pending',
          requestedBy: 'main_agent',
          conversationJid: 'sl:team',
          providerAccountId: 'provider-account:one',
          createdAt: '2026-09-08T00:00:00.000Z',
          updatedAt: '2026-09-08T00:00:00.000Z',
        },
        displayName: 'Google Sheets reader',
        can: 'Read a sheet.',
        cannot: 'Write a sheet.',
        wideningKind: 'added_inputs',
      },
    });

    await completed;
    expect(amendSemanticCapabilityCommandTemplates).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedBy: 'U123',
        approvedByPrincipal: {
          kind: 'human',
          personId: 'person:owner',
          aliasId: 'alias:owner',
        },
      }),
    );
  });
});
