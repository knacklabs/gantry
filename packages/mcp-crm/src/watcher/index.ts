import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { BoondiCrmEnv } from '../env.js';
import type { Logger } from '../logger.js';
import type { RecordsRepository } from '../db/records-repository.js';
import type { ExtractorLlm } from '../extractor/llm-client.js';
import type { BusinessRecord } from '../db/types.js';
import type { ExtractedOpportunity } from '../extractor/types.js';
import { extractOpportunities } from '../extractor/extract.js';
import { applyExtraction } from '../extractor/apply.js';
import {
  findNewDigests,
  advanceDigestCursor,
  type PendingDigestFilter,
} from './digest-source.js';
import {
  loadTranscript,
  phoneFromConversationId,
} from '../reconciler/gantry-source.js';

export interface WatcherDeps {
  env: BoondiCrmEnv;
  logger: Logger;
  pool: Pool;
  repo: RecordsRepository;
  llm: ExtractorLlm | null;
}

export interface DigestCycleStats {
  digests: number;
  extracted: number;
  created: number;
  updated: number;
  skipped: number;
}

export interface DigestCycleOptions extends PendingDigestFilter {
  apply?: boolean;
  trigger?: 'timer' | 'startup';
}

function conversationRef(conversationId: string): string {
  return crypto
    .createHash('sha256')
    .update(conversationId)
    .digest('hex')
    .slice(0, 12);
}

// One summary string per open opportunity, fed to the extractor's matching
// prompt. Single source: both the digest cycle and the manual path must show
// the model IDENTICAL summaries, or their match decisions drift apart.
function openOpportunitySummary(o: BusinessRecord): string {
  return `${o.status} ${o.intentCategory} ${o.occasion ?? ''} qty=${o.quantity ?? '?'}`.trim();
}

function summarizeRecord(
  action: 'created' | 'updated',
  record: BusinessRecord,
): Record<string, unknown> {
  return {
    action,
    id: record.id,
    status: record.status,
    intentCategory: record.intentCategory,
    buyerType: record.buyerType,
    quantity: record.quantity,
    score: record.score,
    band: record.band,
    needsReview: record.needsReview,
  };
}

function summarizeOpportunity(
  o: ExtractedOpportunity,
): Record<string, unknown> {
  return {
    action: o.match ? 'update_candidate' : 'create_candidate',
    match: o.match,
    isLead: o.isLead,
    intentCategory: o.intentCategory,
    buyerType: o.buyerType,
    quantity: o.quantity,
    locationScope: o.locationScope,
    customisation: o.customisation,
    confidence: o.confidence,
  };
}

type TranscriptTurn = { role: 'customer' | 'assistant'; text: string };

const SOFT_BROWSING_RE =
  /\b(?:checking you out|friend mentioned|heard (?:your|the) sweets|new to bss|new here|browsing BSS|recommend(?:ation|ed)?|something (?:really )?(?:good|sweet)|lovely picks?|favourites? right now|favorites? right now)\b/i;

const SEPARATE_ORDER_RE =
  /\b(?:separate|different|another)\s+(?:order|occasion|brief)\b/i;

function inferSoftBrowsingQuery(
  transcript: readonly TranscriptTurn[],
): ExtractedOpportunity | null {
  const customerLine = transcript.find(
    (turn) => turn.role === 'customer' && SOFT_BROWSING_RE.test(turn.text),
  );
  if (!customerLine) return null;
  return {
    match: null,
    isLead: false,
    intentCategory: 'shopping',
    summaryBrief: 'Soft browsing query about Bombay Sweet Shop sweets',
    evidenceQuote: customerLine.text,
    confidence: 0.82,
  };
}

function sameCategory(
  extracted: ExtractedOpportunity,
  existing: BusinessRecord,
): boolean {
  return (
    !extracted.intentCategory ||
    !existing.intentCategory ||
    extracted.intentCategory === existing.intentCategory
  );
}

function coerceSingleOpenOpportunityMatches(
  opportunities: readonly ExtractedOpportunity[],
  open: readonly BusinessRecord[],
  transcript: readonly TranscriptTurn[],
): ExtractedOpportunity[] {
  if (transcript.some((turn) => SEPARATE_ORDER_RE.test(turn.text))) {
    return [...opportunities];
  }
  return opportunities.map((opportunity) => {
    if (opportunity.match) {
      return opportunity;
    }
    const compatible = open
      .filter((record) => sameCategory(opportunity, record))
      .sort((a, b) => {
        const aTime = Date.parse(a.createdAt);
        const bTime = Date.parse(b.createdAt);
        const aRank = Number.isFinite(aTime) ? aTime : Number.MAX_SAFE_INTEGER;
        const bRank = Number.isFinite(bTime) ? bTime : Number.MAX_SAFE_INTEGER;
        return aRank - bRank;
      });
    const existing = compatible[0];
    if (!existing) return opportunity;
    return { ...opportunity, match: existing.id };
  });
}

export async function runDigestCycleOnce(
  deps: WatcherDeps,
  options: DigestCycleOptions = {},
): Promise<DigestCycleStats> {
  const stats: DigestCycleStats = {
    digests: 0,
    extracted: 0,
    created: 0,
    updated: 0,
    skipped: 0,
  };
  if (!deps.llm) return stats;
  const shouldApply = options.apply ?? true;
  const pending = await findNewDigests(
    deps.pool,
    deps.env.gantrySchema,
    deps.env.reconcileAgentId,
    options,
  );
  stats.digests = pending.length;
  if (pending.length > 0) {
    deps.logger.info(
      {
        digests: pending.length,
        agentId: deps.env.reconcileAgentId,
        trigger: options.trigger ?? 'timer',
        apply: shouldApply,
      },
      'digest_cycle_started',
    );
  }
  for (const d of pending) {
    const ref = conversationRef(d.conversationId);
    const phone = phoneFromConversationId(d.conversationId);
    if (!phone) {
      stats.skipped += 1;
      deps.logger.warn(
        {
          digestId: d.digestId,
          conversationRef: ref,
          reason: 'unsupported_conversation_id',
        },
        'digest_skipped',
      );
      continue;
    }
    const transcript = await loadTranscript(
      deps.pool,
      deps.env.gantrySchema,
      d.conversationId,
    );
    const open = await deps.repo.getOpenOpportunitiesByPhone(phone);
    deps.logger.info(
      {
        digestId: d.digestId,
        digestAt: d.digestAt,
        conversationRef: ref,
        transcriptMessages: transcript.length,
        openOpportunities: open.length,
      },
      'digest_process_started',
    );
    const result = await extractOpportunities(
      deps.llm,
      {
        conversationId: d.conversationId,
        phone,
        transcript,
        digestText: d.digestText,
        openOpportunities: open.map((o) => ({
          id: o.id,
          summary: openOpportunitySummary(o),
        })),
      },
      (detail) =>
        deps.logger.warn(
          {
            digestId: d.digestId,
            conversationRef: ref,
            reason: detail.reason,
            rawHead: detail.rawHead,
          },
          'extraction_parse_failed',
        ),
    );
    if (!result) {
      stats.skipped += 1;
      deps.logger.warn(
        {
          digestId: d.digestId,
          conversationRef: ref,
          reason: 'extractor_parse_failed',
        },
        'digest_skipped',
      );
      continue;
    }
    stats.extracted += result.opportunities.length;
    if (!shouldApply) {
      deps.logger.info(
        {
          digestId: d.digestId,
          conversationRef: ref,
          extracted: result.opportunities.length,
          output: result.opportunities.map(summarizeOpportunity),
        },
        'digest_process_completed',
      );
      continue;
    }
    const applied = await applyExtraction(deps.repo, {
      phone,
      conversationId: d.conversationId,
      opportunities: result.opportunities,
    });
    stats.created += applied.created;
    stats.updated += applied.updated;
    await advanceDigestCursor(
      deps.pool,
      d.conversationId,
      d.digestId,
      d.digestAt,
    );
    deps.logger.info(
      {
        digestId: d.digestId,
        conversationRef: ref,
        extracted: result.opportunities.length,
        created: applied.created,
        updated: applied.updated,
        output: applied.records.map(({ action, record }) =>
          summarizeRecord(action, record),
        ),
      },
      'digest_process_completed',
    );
  }
  return stats;
}

export interface ManualExtractionStats {
  extracted: number;
  created: number;
  updated: number;
  skipped: number;
}

// Manual extraction accepts exactly one WhatsApp conversation.
const MANUAL_CONVERSATION_ID_RE = /^conversation:wa:\d+$/;

/**
 * Operator-triggered extraction for ONE conversation, straight from the live
 * transcript. The operator's command IS the boundary signal, so no digest is
 * required and no cursor is read or advanced — boondi_digest_cursor stays
 * exclusively the background cycle's bookmark. Re-runs converge through
 * open-opportunity matching (match → update). digestText is intentionally
 * empty: digest content is a subset of the transcript and carries no
 * matchable ids; see the 2026-06-10 design doc.
 */
export async function runManualConversationExtraction(
  deps: WatcherDeps,
  conversationId: string,
): Promise<ManualExtractionStats> {
  if (!MANUAL_CONVERSATION_ID_RE.test(conversationId)) {
    throw new Error(
      'manual extraction requires a conversation:wa:<digits> conversationId',
    );
  }
  // Defense-in-depth: the HTTP endpoint pre-checks and returns 503.
  if (!deps.llm) throw new Error('extractor_disabled');
  const stats: ManualExtractionStats = {
    extracted: 0,
    created: 0,
    updated: 0,
    skipped: 0,
  };
  const ref = conversationRef(conversationId);
  // Non-null after the regex check; guard kept for type narrowing.
  const phone = phoneFromConversationId(conversationId);
  if (!phone) throw new Error('manual extraction requires a wa conversation');
  const transcript = await loadTranscript(
    deps.pool,
    deps.env.gantrySchema,
    conversationId,
  );
  if (transcript.length === 0) {
    deps.logger.info(
      { conversationRef: ref, transcriptMessages: 0, ...stats },
      'manual_extraction_completed',
    );
    return stats;
  }
  const open = await deps.repo.getOpenOpportunitiesByPhone(phone);
  const result = await extractOpportunities(
    deps.llm,
    {
      conversationId,
      phone,
      transcript,
      digestText: '',
      openOpportunities: open.map((o) => ({
        id: o.id,
        summary: openOpportunitySummary(o),
      })),
    },
    // Operator-facing path: hashed ref only, never rawHead (raw model output
    // could quote the customer's phone or message content).
    (detail) =>
      deps.logger.warn(
        { conversationRef: ref, reason: detail.reason },
        'extraction_parse_failed',
      ),
  );
  if (!result) {
    stats.skipped = 1;
    deps.logger.warn(
      { conversationRef: ref, reason: 'extractor_parse_failed' },
      'manual_extraction_skipped',
    );
    return stats;
  }
  let opportunities = coerceSingleOpenOpportunityMatches(
    result.opportunities,
    open,
    transcript,
  );
  if (opportunities.length === 0) {
    const inferred = inferSoftBrowsingQuery(transcript);
    if (inferred) opportunities = [inferred];
  }
  stats.extracted = opportunities.length;
  const applied = await applyExtraction(deps.repo, {
    phone,
    conversationId,
    opportunities,
  });
  stats.created = applied.created;
  stats.updated = applied.updated;
  deps.logger.info(
    {
      conversationRef: ref,
      transcriptMessages: transcript.length,
      openOpportunities: open.length,
      ...stats,
      output: applied.records.map(({ action, record }) =>
        summarizeRecord(action, record),
      ),
    },
    'manual_extraction_completed',
  );
  return stats;
}

export function startDigestWatcher(deps: WatcherDeps): () => void {
  if (!deps.llm) {
    deps.logger.warn({}, 'extractor_disabled_no_key');
    return () => undefined;
  }
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const stats = await runDigestCycleOnce(deps);
      if (stats.digests > 0) deps.logger.info({ ...stats }, 'digest_cycle');
    } catch (err) {
      deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'digest_cycle_failed',
      );
    } finally {
      running = false;
    }
  };
  deps.logger.info(
    {
      intervalMs: deps.env.reconcileIntervalMs,
      model: deps.env.extractorModel,
    },
    'digest_watcher_started',
  );
  void tick();
  const handle = setInterval(() => void tick(), deps.env.reconcileIntervalMs);
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
