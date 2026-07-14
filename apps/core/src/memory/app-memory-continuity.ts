import { getLastSessionContinuityInjectionStatus } from '../application/sessions/session-continuity-injection-status.js';
import { nowMs as currentTimeMs } from '../shared/time/datetime.js';
import { normalizeSubject } from './app-memory-boundaries.js';
import type {
  AppMemoryItem,
  BlockedDreamDecision,
  MemoryBoundaryContext,
  MemoryReviewRecord,
  MemorySubjectType,
} from './memory-types.js';
type ContinuityMemoryPort = {
  dreamingStatus(
    input?: ContinuityInput,
    options?: { signal?: AbortSignal; statementTimeoutMs?: number },
  ): Promise<ContinuityRun[]>;
  listPendingReviews(
    input?: ContinuityInput,
    options?: { signal?: AbortSignal; statementTimeoutMs?: number },
  ): Promise<MemoryReviewRecord[]>;
  list(
    input?: Partial<MemoryBoundaryContext> & { limit?: number },
    options?: { signal?: AbortSignal; statementTimeoutMs?: number },
  ): Promise<AppMemoryItem[]>;
  listRecentBlockedDreamDecisions?(
    input?: ContinuityInput,
    options?: {
      signal?: AbortSignal;
      statementTimeoutMs?: number;
      limit?: number;
    },
  ): Promise<BlockedDreamDecision[]>;
};
type ContinuityInput = Partial<MemoryBoundaryContext> & {
  subjectType?: MemorySubjectType;
  subjectId?: string;
  deadlineAtMs?: number;
  nowMs?: number;
  signal?: AbortSignal;
  statementTimeoutMs?: number;
};
type ContinuityRun = {
  completedAt?: string | null;
  startedAt: string;
  status: string;
  phase: string;
  summary: unknown;
};
export async function buildAppMemoryContinuityStatus(
  memory: ContinuityMemoryPort,
  input: Partial<MemoryBoundaryContext> = {},
) {
  const subject = normalizeSubject(input);
  const [runs, reviews] = await Promise.all([
    memory.dreamingStatus(subject),
    memory.listPendingReviews(subject),
  ]);
  return statusFromParts(subject, runs, reviews.length);
}
export async function buildAppMemoryContinuitySummary(
  memory: ContinuityMemoryPort,
  input: ContinuityInput = {},
) {
  const subject = normalizeSubject(input);
  const startedAtMs = input.nowMs ?? currentTimeMs();
  const hasBlockedDreamDecisionSection =
    memory.listRecentBlockedDreamDecisions !== undefined;
  const [memoriesResult, runsResult, reviewsResult, blockedResult] =
    await Promise.all([
      settleContinuitySection(
        (signal, statementTimeoutMs) =>
          memory.list(
            { ...subject, limit: 100 },
            { signal, statementTimeoutMs },
          ),
        input.deadlineAtMs,
        startedAtMs,
        input.signal,
        input.statementTimeoutMs,
      ),
      settleContinuitySection(
        (signal, statementTimeoutMs) =>
          memory.dreamingStatus(subject, { signal, statementTimeoutMs }),
        input.deadlineAtMs,
        startedAtMs,
        input.signal,
        input.statementTimeoutMs,
      ),
      settleContinuitySection(
        (signal, statementTimeoutMs) =>
          memory.listPendingReviews(subject, { signal, statementTimeoutMs }),
        input.deadlineAtMs,
        startedAtMs,
        input.signal,
        input.statementTimeoutMs,
      ),
      hasBlockedDreamDecisionSection
        ? settleContinuitySection(
            (signal, statementTimeoutMs) =>
              memory.listRecentBlockedDreamDecisions?.(subject, {
                signal,
                statementTimeoutMs,
                limit: 10,
              }) ?? Promise.resolve([]),
            input.deadlineAtMs,
            startedAtMs,
            input.signal,
            input.statementTimeoutMs,
          )
        : Promise.resolve({ status: 'fulfilled' as const, value: [] }),
    ]);
  const memories =
    memoriesResult.status === 'fulfilled' ? memoriesResult.value : [];
  const runs = runsResult.status === 'fulfilled' ? runsResult.value : [];
  const reviews =
    reviewsResult.status === 'fulfilled' ? reviewsResult.value : [];
  const blocked =
    blockedResult.status === 'fulfilled' ? blockedResult.value : [];
  const status = statusFromParts(subject, runs, reviews.length);
  const injected = injectedStatus(subject);
  const recentDecisions = memories
    .filter((item) => item.kind === 'decision')
    .slice(0, 10)
    .map((item) => ({
      id: item.id,
      key: item.key,
      value: item.value,
      updated_at: item.updatedAt,
    }));
  const latestDreamSummary = summaryObject(runs[0]?.summary);
  const lastRun = runs[0];
  const sectionResults = [
    memoriesResult,
    runsResult,
    reviewsResult,
    ...(hasBlockedDreamDecisionSection ? [blockedResult] : []),
  ];
  const unavailableCount = sectionResults.filter(
    (result) => result.status === 'unavailable',
  ).length;
  const sectionCount = sectionResults.length;
  return {
    overall_status:
      unavailableCount === 0
        ? 'complete'
        : unavailableCount === sectionCount
          ? 'unavailable'
          : 'partial',
    subject,
    active_count: memories.length,
    staged_count: status.stagedCount,
    promoted_count: status.promotedCount,
    needs_review_count: status.needsReviewCount,
    last_injected_block: status.lastInjectedBlock,
    last_dream_run: status.lastDreamRun,
    sections: {
      recent_decisions: section(
        memoriesResult.status === 'unavailable'
          ? 'unavailable'
          : recentDecisions.length > 0
            ? 'populated'
            : 'empty',
        recentDecisions,
        memoriesResult.status === 'unavailable'
          ? memoriesResult.reason
          : undefined,
      ),
      active_paused_jobs: sectionFromInjected(
        injected?.sections.active_paused_jobs,
      ),
      last_runs: sectionFromInjected(
        injected?.sections.recent_session_digests,
        'No session digest loader was available for this subject.',
      ),
      last_dream_summary: section(
        runsResult.status === 'unavailable'
          ? 'unavailable'
          : lastRun && latestDreamSummary
            ? 'populated'
            : 'empty',
        lastRun && latestDreamSummary
          ? [
              {
                at: lastRun.completedAt || lastRun.startedAt,
                status: lastRun.status,
                phase: lastRun.phase,
                summary: latestDreamSummary,
              },
            ]
          : [],
        runsResult.status === 'unavailable' ? runsResult.reason : undefined,
      ),
      blocked_dream_decisions: section(
        blockedResult.status === 'unavailable'
          ? 'unavailable'
          : blocked.length > 0
            ? 'populated'
            : 'empty',
        blocked.map((item) => ({
          id: item.id,
          run_id: item.runId,
          candidate_id: item.candidateId,
          item_id: item.itemId,
          subject_type: item.subjectType,
          subject_id: item.subjectId,
          kind: item.kind,
          key: item.key,
          value: item.value,
          rationale: item.rationale,
          created_at: item.createdAt,
        })),
        blockedResult.status === 'unavailable'
          ? blockedResult.reason
          : undefined,
      ),
      issue_index: section(
        'deferred',
        [],
        'No issue index repository is wired into memory continuity.',
      ),
    },
  };
}
function statusFromParts(
  subject: ReturnType<typeof normalizeSubject>,
  runs: ContinuityRun[],
  reviewCount: number,
) {
  const latestRun = runs[0];
  const summary = summaryObject(latestRun?.summary) ?? {};
  const injected = injectedStatus(subject);
  return {
    subject,
    stagedCount: Number(summary.staged ?? summary.stageCandidate ?? 0),
    promotedCount: Number(summary.promoted ?? 0),
    needsReviewCount: reviewCount || Number(summary.needsReview ?? 0),
    ...(injected
      ? {
          lastInjectedBlock: {
            subject: [
              injected.subject.appId,
              injected.subject.agentId,
              injected.subject.conversationId,
            ]
              .filter(Boolean)
              .join(':'),
            bytes: injected.bytes,
            at: injected.injectedAt,
          },
        }
      : {}),
    lastDreamRun: latestRun
      ? {
          at: latestRun.completedAt || latestRun.startedAt,
          status: latestRun.status,
          phase: latestRun.phase,
          summary,
        }
      : undefined,
  };
}
function injectedStatus(subject: ReturnType<typeof normalizeSubject>) {
  return getLastSessionContinuityInjectionStatus({
    appId: subject.appId,
    agentId: subject.agentId,
    conversationId: subject.channelId,
    userId: subject.userId,
  });
}
function summaryObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}
function section(status: string, items: unknown[], reason?: string) {
  return { status, count: items.length, items, ...(reason ? { reason } : {}) };
}
function sectionFromInjected(
  source: { status: string; count: number; items?: unknown[] } | undefined,
  reason = 'No continuity jobs loader has injected data for this subject.',
) {
  return source
    ? {
        status: source.status,
        count: source.count,
        items: (source.items || []).slice(0, 8),
      }
    : section('unavailable', [], reason);
}

async function settleContinuitySection<T>(
  work: (signal: AbortSignal, statementTimeoutMs?: number) => Promise<T>,
  deadlineAtMs: number | undefined,
  nowMs: number,
  parentSignal?: AbortSignal,
  statementTimeoutMs?: number,
): Promise<ContinuitySectionResult<T>> {
  const remainingMs = deadlineAtMs ? deadlineAtMs - nowMs : undefined;
  if (parentSignal?.aborted) {
    return { status: 'unavailable', reason: 'deadline_exceeded' };
  }
  if (
    remainingMs !== undefined &&
    remainingMs <= MEMORY_CONTINUITY_DEADLINE_SAFETY_MS
  ) {
    return { status: 'unavailable', reason: 'deadline_exceeded' };
  }
  const controller = new AbortController();
  const abortFromParent = () =>
    controller.abort(parentSignal?.reason ?? new Error('memory IPC aborted'));
  parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const effectiveStatementTimeoutMs =
    statementTimeoutMs ??
    (remainingMs === undefined
      ? undefined
      : Math.max(1, remainingMs - MEMORY_CONTINUITY_DEADLINE_SAFETY_MS));
  const promise = work(controller.signal, effectiveStatementTimeoutMs);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ status: 'fulfilled' as const, value })),
      new Promise<{ status: 'unavailable'; reason: string }>((resolve) => {
        if (remainingMs === undefined) return;
        timeout = setTimeout(
          () => {
            controller.abort(new Error('memory continuity deadline exceeded'));
            resolve({ status: 'unavailable', reason: 'deadline_exceeded' });
          },
          Math.max(1, remainingMs - MEMORY_CONTINUITY_DEADLINE_SAFETY_MS),
        );
      }),
    ]);
  } catch {
    if (controller.signal.aborted || parentSignal?.aborted) {
      return { status: 'unavailable', reason: 'deadline_exceeded' };
    }
    return { status: 'unavailable', reason: 'service_error' };
  } finally {
    if (timeout) clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', abortFromParent);
    promise.catch(() => undefined);
  }
}

const MEMORY_CONTINUITY_DEADLINE_SAFETY_MS = 1_000;

type ContinuitySectionResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'unavailable'; reason: string };
