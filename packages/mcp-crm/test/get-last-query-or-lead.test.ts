import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

import type { RecordsRepository } from '../src/db/records-repository.js';
import type { BusinessRecord } from '../src/db/types.js';
import { runWithIdentity } from '../src/identity/identity-context.js';
import { registerGetLastQueryOrLead } from '../src/tools/get-last-query-or-lead.js';
import type { ToolContent } from '../src/tools/shared.js';

type ToolHandler = () => Promise<ToolContent>;

function captureGetLastQueryOrLeadTool(
  repo: Pick<RecordsRepository, 'getLastOpenOpportunityByPhone'>,
) {
  let handler: ToolHandler | undefined;
  let description = '';
  const server = {
    tool: (
      name: string,
      registeredDescription: string,
      _schema: unknown,
      registeredHandler: ToolHandler,
    ) => {
      expect(name).toBe('get_last_query_or_lead');
      description = registeredDescription;
      handler = registeredHandler;
    },
  } as unknown as McpServer;

  registerGetLastQueryOrLead(server, repo as RecordsRepository);
  if (!handler)
    throw new Error('get_last_query_or_lead handler was not registered');
  return { handler, description };
}

function businessRecord(
  overrides: Partial<BusinessRecord> = {},
): BusinessRecord {
  return {
    id: 'bcr_latest',
    phone: '000000050',
    customerName: null,
    conversationId: 'conversation:wa:000000050',
    status: 'query',
    intentCategory: 'gifting_personal',
    occasion: 'birthday',
    quantity: 12,
    quantityRaw: '10-12 boxes',
    budgetPerGiftInr: 500,
    budgetTotalInr: null,
    budgetRaw: 'around 500 each',
    locations: 'Mumbai',
    locationScope: null,
    timeline: 'next week',
    timelineDays: null,
    buyerType: null,
    customisation: null,
    contactQuality: null,
    score: 42,
    band: 'P4',
    confidence: 0.82,
    needsReview: true,
    summaryBrief: '10-12 birthday boxes around Rs 500 each',
    triggerExcerpt: null,
    source: 'extractor',
    createdAt: '2026-06-17T04:54:36.165Z',
    updatedAt: '2026-06-18T04:54:36.165Z',
    ...overrides,
  };
}

describe('get_last_query_or_lead tool', () => {
  it('returns only the compact newest open record payload for greetings', async () => {
    const repo = {
      getLastOpenOpportunityByPhone: vi.fn(async () => businessRecord()),
    };
    const { handler } = captureGetLastQueryOrLeadTool(repo);

    const result = await runWithIdentity(
      { phone: '000000050', issuedAtMs: Date.now() },
      handler,
    );
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      found?: boolean;
      record?: Record<string, unknown>;
    };

    expect(repo.getLastOpenOpportunityByPhone).toHaveBeenCalledWith(
      '000000050',
    );
    expect(payload.found).toBe(true);
    expect(payload.record).toEqual({
      id: 'bcr_latest',
      status: 'query',
      intentCategory: 'gifting_personal',
      summaryBrief: '10-12 birthday boxes around Rs 500 each',
      occasion: 'birthday',
      quantity: 12,
      quantityRaw: '10-12 boxes',
      budgetPerGiftInr: 500,
      budgetRaw: 'around 500 each',
      locations: 'Mumbai',
      timeline: 'next week',
      updatedAt: '2026-06-18T04:54:36.165Z',
    });
    expect(payload).not.toHaveProperty('customerReplyDraft');
    expect(payload.record).not.toHaveProperty('score');
    expect(payload.record).not.toHaveProperty('band');
    expect(payload.record).not.toHaveProperty('needsReview');
  });

  it('returns found false without bulky fields when no open record exists', async () => {
    const repo = {
      getLastOpenOpportunityByPhone: vi.fn(async () => null),
    };
    const { handler } = captureGetLastQueryOrLeadTool(repo);

    const result = await runWithIdentity(
      { phone: '000000050', issuedAtMs: Date.now() },
      handler,
    );
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      found?: boolean;
    };

    expect(payload).toEqual({ found: false });
  });

  it('describes latest-record lookup as prior-context only, not clear new requests', () => {
    const repo = {
      getLastOpenOpportunityByPhone: vi.fn(async () => null),
    };
    const { description } = captureGetLastQueryOrLeadTool(repo);

    expect(description).toMatch(/continue prior business-interest context/i);
    expect(description).toMatch(/Do not call for clear standalone new requests/i);
    expect(description).toMatch(/new corporate quote/i);
    expect(description).toMatch(/gift-message/i);
  });
});
