import type { MemoryIpcRequest, MemoryIpcResponse } from '@gantry/contracts';

import { nowMs } from '../shared/time/datetime.js';
import { AppMemoryService } from './app-memory-service.js';
import { toMemoryReviewDisplayPage } from './app-memory-review-readable.js';
import {
  assertMemoryRequestNotExpired,
  deadlineUnavailableResponse,
  hasEnoughMemoryBudget,
  runWithinMemoryDeadline,
} from './memory-ipc-deadline.js';
import {
  parseOptionalNumber,
  parseReviewDecisionRequest,
} from './memory-ipc-parsing.js';
import type {
  MemoryReviewDisplayPage,
  MemoryReviewPageContext,
  NormalizedMemorySubject,
} from './memory-types.js';

interface TrustedMemoryContext {
  personId?: string;
  reviewerIsControlApprover?: boolean;
}

type MemoryReviewTrustedRequest = Omit<MemoryIpcRequest, 'context'> & {
  context?: TrustedMemoryContext;
  deadlineAtMs?: number;
};

const MEMORY_REVIEW_PROVIDER = 'postgres';

export async function processPendingMemoryReviewRequest(input: {
  request: MemoryReviewTrustedRequest;
  subject: NormalizedMemorySubject;
}): Promise<MemoryIpcResponse> {
  if (!hasEnoughMemoryBudget(input.request, nowMs)) {
    return deadlineUnavailableResponse(input.request, MEMORY_REVIEW_PROVIDER);
  }
  const paging = parsePendingReviewPaging(input.request.payload);
  const reviewsOutcome = await runWithinMemoryDeadline(
    input.request,
    (signal, statementTimeoutMs) =>
      AppMemoryService.getInstance().listPendingReviewPage(
        {
          ...input.subject,
          appId: input.subject.appId,
          agentId: input.subject.agentId,
          subjectType: input.subject.subjectType,
          subjectId: input.subject.subjectId,
        },
        { signal, statementTimeoutMs, ...paging },
      ),
    nowMs,
  );
  if (reviewsOutcome.status === 'deadline_exceeded') {
    return deadlineUnavailableResponse(input.request, MEMORY_REVIEW_PROVIDER);
  }
  const page = reviewsOutcome.value;
  const reviewPage =
    page.reviewPage ||
    toMemoryReviewDisplayPage({
      reviews: page.reviews,
      subject: input.subject,
      totalCount: page.totalCount,
      returnedCount: page.returnedCount,
      remainingCount: page.remainingCount,
      limit: page.limit,
      offset: page.offset,
      nextOffset: page.nextOffset,
    });
  const reviewPageWire = toReviewPageWire(reviewPage);
  return {
    ok: true,
    requestId: input.request.requestId,
    provider: MEMORY_REVIEW_PROVIDER,
    data: {
      reviews: page.reviews,
      review_page: reviewPageWire,
      page_context: reviewPageWire.page_context,
      total_count: page.totalCount,
      returned_count: page.returnedCount,
      remaining_count: page.remainingCount,
      limit: page.limit,
      offset: page.offset,
      next_offset: page.nextOffset,
    },
  };
}

export async function processMemoryReviewDecisionRequest(input: {
  request: MemoryReviewTrustedRequest;
  subject: NormalizedMemorySubject;
}): Promise<MemoryIpcResponse> {
  const decisionInput = parseReviewDecisionRequest(input.request.payload);
  if (!input.request.context?.personId) {
    throw new Error(
      'memory_review_decision requires a trusted reviewer user id',
    );
  }
  if (!input.request.context.reviewerIsControlApprover) {
    throw new Error(
      'memory_review_decision requires a conversation control approver',
    );
  }
  const reviewerId = input.request.context.personId;
  if (!hasEnoughMemoryBudget(input.request, nowMs)) {
    return deadlineUnavailableResponse(input.request, MEMORY_REVIEW_PROVIDER);
  }
  const memory = AppMemoryService.getInstance();
  if (decisionInput.kind === 'batch') {
    if (!sameReviewPageSubject(decisionInput.pageContext, input.subject)) {
      throw new Error(
        'memory_review_decision page_context is outside trusted subject scope',
      );
    }
    const outcomes = [];
    for (const decision of decisionInput.decisions) {
      const resolved = resolveReviewIdFromBatchDecision(
        decisionInput.pageContext,
        decision,
      );
      const reviewId = resolved.reviewId;
      if (!reviewId) {
        outcomes.push({
          number: decision.number ?? null,
          review_id: null,
          decision: decision.decision,
          ok: false,
          error:
            resolved.error || 'review number is not present in page_context',
        });
        continue;
      }
      try {
        const review = await runMemoryMutation(input.request, () =>
          memory.decideReview({
            ...input.subject,
            appId: input.subject.appId,
            agentId: input.subject.agentId,
            subjectType: input.subject.subjectType,
            subjectId: input.subject.subjectId,
            reviewId,
            decision: decision.decision,
            ...(decision.editedValue !== undefined
              ? { editedValue: decision.editedValue }
              : {}),
            ...(decision.editedReason !== undefined
              ? { editedReason: decision.editedReason }
              : {}),
            reviewerId,
          }),
        );
        outcomes.push({
          number: decision.number ?? null,
          review_id: reviewId,
          decision: decision.decision,
          ok: true,
          review_status: review.status,
          apply_outcome: review.applyOutcome ?? null,
        });
      } catch (error) {
        outcomes.push({
          number: decision.number ?? null,
          review_id: reviewId,
          decision: decision.decision,
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : 'unknown memory review decision failure',
        });
      }
    }
    return {
      ok: true,
      requestId: input.request.requestId,
      provider: MEMORY_REVIEW_PROVIDER,
      data: {
        decision_batch: {
          requested_count: decisionInput.decisions.length,
          processed_count: outcomes.filter((item) => item.ok).length,
          failed_count: outcomes.filter((item) => !item.ok).length,
          remaining_count: await countRemainingPendingReviews(
            memory,
            input.subject,
            input.request,
          ),
          outcomes,
        },
      },
    };
  }
  const review = await runMemoryMutation(input.request, () =>
    memory.decideReview({
      ...input.subject,
      appId: input.subject.appId,
      agentId: input.subject.agentId,
      subjectType: input.subject.subjectType,
      subjectId: input.subject.subjectId,
      reviewId: decisionInput.reviewId,
      decision: decisionInput.decision,
      ...(decisionInput.editedValue !== undefined
        ? { editedValue: decisionInput.editedValue }
        : {}),
      ...(decisionInput.editedReason !== undefined
        ? { editedReason: decisionInput.editedReason }
        : {}),
      reviewerId,
    }),
  );
  return {
    ok: true,
    requestId: input.request.requestId,
    provider: MEMORY_REVIEW_PROVIDER,
    data: { review },
  };
}

function parsePendingReviewPaging(payload: Record<string, unknown>): {
  limit?: number;
  offset?: number;
} {
  const limit = parseOptionalNumber(payload.limit);
  const offset = parseOptionalNumber(payload.offset);
  return {
    ...(limit === undefined ? {} : { limit: Math.trunc(limit) }),
    ...(offset === undefined ? {} : { offset: Math.trunc(offset) }),
  };
}

async function runMemoryMutation<T>(
  request: MemoryReviewTrustedRequest,
  work: () => Promise<T>,
): Promise<T> {
  assertMemoryRequestNotExpired(request, nowMs);
  return work();
}

function sameReviewPageSubject(
  pageContext: MemoryReviewPageContext,
  subject: NormalizedMemorySubject,
): boolean {
  return (
    pageContext.subject.appId === subject.appId &&
    pageContext.subject.agentId === subject.agentId &&
    pageContext.subject.subjectType === subject.subjectType &&
    pageContext.subject.subjectId === subject.subjectId
  );
}

function resolveReviewIdFromBatchDecision(
  pageContext: MemoryReviewPageContext,
  decision: { number?: number; reviewId?: string },
): { reviewId?: string; error?: string } {
  if (decision.number === undefined) {
    if (!decision.reviewId) return {};
    return pageContext.reviewIds.includes(decision.reviewId)
      ? { reviewId: decision.reviewId }
      : { error: 'review_id is not present in page_context' };
  }
  const mappedReviewId = pageContext.reviewIds[decision.number - 1];
  if (!mappedReviewId) {
    return { error: 'review number is not present in page_context' };
  }
  if (decision.reviewId && decision.reviewId !== mappedReviewId) {
    return { error: 'review_id does not match page_context number' };
  }
  return { reviewId: decision.reviewId || mappedReviewId };
}

async function countRemainingPendingReviews(
  memory: AppMemoryService,
  subject: NormalizedMemorySubject,
  request: MemoryReviewTrustedRequest,
): Promise<number | null> {
  if (!hasEnoughMemoryBudget(request, nowMs)) return null;
  try {
    const remainingOutcome = await runWithinMemoryDeadline(
      request,
      (signal, statementTimeoutMs) =>
        memory.listPendingReviewPage(
          {
            ...subject,
            appId: subject.appId,
            agentId: subject.agentId,
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
          },
          { signal, statementTimeoutMs, limit: 1, offset: 0 },
        ),
      nowMs,
    );
    return remainingOutcome.status === 'completed'
      ? remainingOutcome.value.totalCount
      : null;
  } catch {
    return null;
  }
}

function toReviewPageWire(page: MemoryReviewDisplayPage) {
  return {
    items: page.items.map((item) => ({
      number: item.number,
      review_id: item.reviewId,
      action: item.action,
      summary: item.summary,
      ...(item.before !== undefined ? { before: item.before } : {}),
      ...(item.after !== undefined ? { after: item.after } : {}),
      ...(item.target !== undefined ? { target: item.target } : {}),
      ...(item.retiring !== undefined ? { retiring: item.retiring } : {}),
      reason: item.reason,
      confidence: item.confidence,
      evidence_ids: item.evidenceIds,
      evidence: item.evidence.map((evidence) => ({
        evidence_id: evidence.evidenceId,
        source_type: evidence.sourceType,
        source_id: evidence.sourceId ?? null,
        snippet: evidence.snippet,
        created_at: evidence.createdAt,
      })),
      decision_options: item.decisionOptions,
    })),
    page_context: {
      subject: {
        app_id: page.pageContext.subject.appId,
        agent_id: page.pageContext.subject.agentId,
        subject_type: page.pageContext.subject.subjectType,
        subject_id: page.pageContext.subject.subjectId,
      },
      limit: page.pageContext.limit,
      offset: page.pageContext.offset,
      review_ids: page.pageContext.reviewIds,
    },
    total_count: page.totalCount,
    returned_count: page.returnedCount,
    remaining_count: page.remainingCount,
    limit: page.limit,
    offset: page.offset,
    next_offset: page.nextOffset,
  };
}
