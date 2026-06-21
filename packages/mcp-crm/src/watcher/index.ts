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
  trigger?: 'timer' | 'manual';
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

export type ManualExtractionStats = DigestCycleStats;

// Manual extraction accepts exactly one WhatsApp conversation.
const MANUAL_CONVERSATION_ID_RE = /^conversation:wa:\d+$/;

/**
 * Operator-triggered extraction for ONE conversation using the same digest-based
 * path as the automatic watcher. If no pending digest exists, it is a no-op.
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
  return runDigestCycleOnce(deps, { conversationId, trigger: 'manual' });
}

export function startDigestWatcher(deps: WatcherDeps): () => void {
  if (!deps.env.crmLeadQueryExtractionWatcher.enabled) {
    deps.logger.info({}, 'digest_watcher_disabled');
    return () => undefined;
  }
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
      intervalMs: deps.env.crmLeadQueryExtractionWatcher.pollIntervalMs,
      model: deps.env.crmLeadQueryExtractionWatcher.model,
    },
    'digest_watcher_started',
  );
  const handle = setInterval(
    () => void tick(),
    deps.env.crmLeadQueryExtractionWatcher.pollIntervalMs,
  );
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
