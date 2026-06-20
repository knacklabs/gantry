import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BusinessRecord } from '../db/types.js';
import type { RecordsRepository } from '../db/records-repository.js';
import { getCallerPhone, jsonContent, toolErrorContent } from './shared.js';

type CompactOpenRecord = {
  id: string;
  status: BusinessRecord['status'];
  intentCategory: BusinessRecord['intentCategory'];
  summaryBrief?: string;
  occasion?: string;
  quantity?: number;
  // Raw fields preserve the customer's own wording, e.g. "10-12 boxes"
  // or "around 500 each", instead of over-normalising fuzzy intent.
  quantityRaw?: string;
  budgetPerGiftInr?: number;
  budgetRaw?: string;
  locations?: string;
  timeline?: string;
  updatedAt: string;
};

function compactRecord(rec: BusinessRecord): CompactOpenRecord {
  return {
    id: rec.id,
    status: rec.status,
    intentCategory: rec.intentCategory,
    updatedAt: rec.updatedAt,
    ...(rec.summaryBrief ? { summaryBrief: rec.summaryBrief } : {}),
    ...(rec.occasion ? { occasion: rec.occasion } : {}),
    ...(rec.quantity !== null ? { quantity: rec.quantity } : {}),
    ...(rec.quantityRaw ? { quantityRaw: rec.quantityRaw } : {}),
    ...(rec.budgetPerGiftInr !== null
      ? { budgetPerGiftInr: rec.budgetPerGiftInr }
      : {}),
    ...(rec.budgetRaw ? { budgetRaw: rec.budgetRaw } : {}),
    ...(rec.locations ? { locations: rec.locations } : {}),
    ...(rec.timeline ? { timeline: rec.timeline } : {}),
  };
}

export function registerGetLastQueryOrLead(
  server: McpServer,
  repo: RecordsRepository,
): void {
  server.tool(
    'get_last_query_or_lead',
    "Return only the verified caller's newest active CRM query/lead when the message appears to continue prior business-interest context or the customer explicitly asks to pick up an earlier query. Use empty arguments {}. Do not call for clear standalone new requests such as a new corporate quote, gift-message, product recommendation, checkout, policy, order-support, delivery, invoice, cancellation, refund, or complaint question. Response is intentionally compact; use get_open_records only when you need every active opportunity.",
    {},
    async () => {
      try {
        const phone = getCallerPhone();
        if (!phone) {
          return toolErrorContent(
            'IDENTITY_REQUIRED',
            'No verified caller identity on this request.',
          );
        }
        const rec = await repo.getLastOpenOpportunityByPhone(phone);
        if (!rec) return jsonContent({ found: false });

        return jsonContent({
          found: true,
          record: compactRecord(rec),
        });
      } catch (err) {
        return toolErrorContent(
          'INTERNAL_ERROR',
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  );
}
