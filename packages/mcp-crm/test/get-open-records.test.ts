import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

import type { RecordsRepository } from '../src/db/records-repository.js';
import type { BusinessRecord } from '../src/db/types.js';
import { runWithIdentity } from '../src/identity/identity-context.js';
import { registerGetOpenRecords } from '../src/tools/get-open-records.js';
import type { ToolContent } from '../src/tools/shared.js';

type ToolHandler = () => Promise<ToolContent>;

function captureGetOpenRecordsTool(
  repo: Pick<RecordsRepository, 'getOpenOpportunitiesByPhone'>,
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
      expect(name).toBe('get_open_records');
      description = registeredDescription;
      handler = registeredHandler;
    },
  } as unknown as McpServer;

  registerGetOpenRecords(server, repo as RecordsRepository);
  if (!handler) throw new Error('get_open_records handler was not registered');
  return { handler, description };
}

function leadRecord(overrides: Partial<BusinessRecord> = {}): BusinessRecord {
  return {
    id: 'bcr_returning',
    phone: '000000050',
    customerName: null,
    conversationId: 'conversation:wa:000000050',
    status: 'lead',
    intentCategory: 'corporate',
    occasion: 'Diwali',
    quantity: 300,
    quantityRaw: 'around 300',
    budgetPerGiftInr: null,
    budgetTotalInr: null,
    budgetRaw: null,
    locations: null,
    locationScope: null,
    timeline: null,
    timelineDays: null,
    buyerType: 'employee_gifting',
    customisation: null,
    contactQuality: null,
    score: 77,
    band: 'P2',
    confidence: 0.9,
    needsReview: false,
    summaryBrief: 'Returning: ~300 Diwali boxes for the team',
    triggerExcerpt: null,
    source: 'seed',
    createdAt: '2026-06-17T04:54:36.165Z',
    updatedAt: '2026-06-17T04:54:36.165Z',
    ...overrides,
  };
}

describe('get_open_records tool', () => {
  it('returns explicit recognition guidance and draft for open records', async () => {
    const repo = {
      getOpenOpportunitiesByPhone: vi.fn(async () => [leadRecord()]),
    };
    const { handler } = captureGetOpenRecordsTool(repo);

    const result = await runWithIdentity(
      { phone: '000000050', issuedAtMs: Date.now() },
      handler,
    );
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      found?: boolean;
      answerGuidance?: { recognitionLine?: string };
      customerReplyDraft?: string;
    };

    expect(payload.found).toBe(true);
    expect(payload.answerGuidance?.recognitionLine).toContain('Diwali');
    expect(payload.answerGuidance?.recognitionLine).toContain('300');
    expect(payload.customerReplyDraft).toMatch(/welcome back/i);
    expect(payload.customerReplyDraft).toContain('Diwali');
    expect(payload.customerReplyDraft).toContain('300');
  });

  it('describes open-record lookup as returning context, not automatic first-turn lookup', () => {
    const repo = {
      getOpenOpportunitiesByPhone: vi.fn(async () => []),
    };
    const { description } = captureGetOpenRecordsTool(repo);

    expect(description).toMatch(/continuing prior business-interest context/i);
    expect(description).toMatch(/Do not call for a brand-new one-off/i);
    expect(description).toMatch(/prefer get_last_query_or_lead/i);
    expect(description).not.toMatch(/on the first turn/i);
  });
});
