import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BusinessRecord } from '../db/types.js';
import type { RecordsRepository } from '../db/records-repository.js';
import { getCallerPhone, jsonContent, toolErrorContent } from './shared.js';

function describeRecordForRecognition(rec: BusinessRecord): string {
  const parts: string[] = [];
  const quantity = rec.quantityRaw ?? (rec.quantity ? `${rec.quantity}` : null);
  if (quantity) parts.push(quantity);
  if (rec.occasion) parts.push(rec.occasion);
  if (rec.summaryBrief) parts.push(rec.summaryBrief);
  else if (rec.buyerType === 'employee_gifting') parts.push('team gifting');
  else if (rec.buyerType === 'client_vip_procurement') {
    parts.push('client gifting');
  }
  if (rec.locations) parts.push(rec.locations);
  if (rec.timeline) parts.push(rec.timeline);
  if (rec.budgetRaw) parts.push(rec.budgetRaw);
  else if (rec.budgetPerGiftInr) parts.push(`₹${rec.budgetPerGiftInr} per gift`);

  return parts.filter((part) => part.trim().length > 0).join(' · ');
}

function buildRecognitionReplyDraft(records: BusinessRecord[]): string | null {
  const [first] = records;
  if (!first) return null;

  const quantity = first.quantityRaw ?? (first.quantity ? `${first.quantity}` : null);
  const occasion = first.occasion;
  const buyer =
    first.buyerType === 'employee_gifting'
      ? 'for your team'
      : first.buyerType === 'client_vip_procurement'
        ? 'for your clients'
        : null;
  const detail =
    [quantity, occasion, buyer].filter((part): part is string => Boolean(part)).join(
      ' ',
    ) || describeRecordForRecognition(first);

  if (!detail) return null;
  return `Welcome back! Last time we were talking about ${detail} - shall we pick that up?`;
}

function buildRecognitionGuidance(records: BusinessRecord[]): {
  recognitionLine: string;
  mustMention: string[];
} | null {
  const [first] = records;
  if (!first) return null;

  const recognitionLine = describeRecordForRecognition(first);
  const mustMention = [
    first.occasion,
    first.quantityRaw,
    first.quantity ? `${first.quantity}` : null,
    first.summaryBrief,
  ].filter((part): part is string => Boolean(part));

  if (!recognitionLine && mustMention.length === 0) return null;
  return {
    recognitionLine,
    mustMention,
  };
}

export function registerGetOpenRecords(
  server: McpServer,
  repo: RecordsRepository,
): void {
  server.tool(
    'get_open_records',
    "Return all of the verified caller's OPEN opportunities (queries/leads) when the customer appears to be continuing prior business-interest context or you explicitly need every active opportunity. Use empty arguments {}. Do not call for a brand-new one-off product, gift-message, policy, checkout, order-support, delivery, invoice, cancellation, refund, complaint, or customization question; answer those from the relevant source/KB instead. For a lightweight returning-customer greeting, prefer get_last_query_or_lead.",
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
        const recs = await repo.getOpenOpportunitiesByPhone(phone);
        const answerGuidance = buildRecognitionGuidance(recs);
        const customerReplyDraft = buildRecognitionReplyDraft(recs);
        return jsonContent({
          found: recs.length > 0,
          records: recs.map((rec) => ({
            id: rec.id,
            status: rec.status,
            intentCategory: rec.intentCategory,
            occasion: rec.occasion,
            quantity: rec.quantity,
            quantityRaw: rec.quantityRaw,
            budgetPerGiftInr: rec.budgetPerGiftInr,
            budgetRaw: rec.budgetRaw,
            locations: rec.locations,
            timeline: rec.timeline,
            buyerType: rec.buyerType,
            customisation: rec.customisation,
            score: rec.score,
            band: rec.band,
            summaryBrief: rec.summaryBrief,
            needsReview: rec.needsReview,
            updatedAt: rec.updatedAt,
          })),
          ...(answerGuidance ? { answerGuidance } : {}),
          ...(customerReplyDraft ? { customerReplyDraft } : {}),
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
