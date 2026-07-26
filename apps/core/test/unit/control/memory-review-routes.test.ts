import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ControlRouteContext } from '@core/control/server/handler-context.js';

const serviceMock = vi.hoisted(() => ({
  isEnabled: vi.fn(() => true),
  getReviewDetail: vi.fn(),
}));

const ipcMock = vi.hoisted(() => ({
  processPendingMemoryReviewRequest: vi.fn(),
  processMemoryReviewDecisionRequest: vi.fn(),
}));

vi.mock('@core/memory/app-memory-service.js', () => ({
  AppMemoryService: { getInstance: () => serviceMock },
}));

vi.mock('@core/memory/memory-review-ipc.js', () => ipcMock);

import { handleMemoryRoutes } from '@core/control/server/routes/memory.js';

const SUBJECT_QUERY = 'agentId=agent-1&subjectType=user&subjectId=user-9';

function responseRecorder(): ServerResponse & { body: string } {
  return {
    statusCode: 0,
    body: '',
    setHeader: vi.fn(),
    end(chunk?: unknown) {
      this.body += chunk ? String(chunk) : '';
      return this;
    },
  } as unknown as ServerResponse & { body: string };
}

function ctxWith(scopes: string[]): ControlRouteContext {
  return {
    keys: [
      {
        kid: 'key-42',
        tokenHash: createHash('sha256').update('test-token').digest(),
        scopes: new Set(scopes),
        appId: 'default',
      },
    ],
  } as unknown as ControlRouteContext;
}

async function call(
  method: string,
  pathWithQuery: string,
  ctx: ControlRouteContext,
  body?: unknown,
): Promise<ServerResponse & { body: string }> {
  const url = new URL(`http://localhost${pathWithQuery}`);
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as unknown as IncomingMessage & { method: string; headers: object };
  req.method = method;
  req.headers = { authorization: 'Bearer test-token' };
  const res = responseRecorder();
  await handleMemoryRoutes(req, res, ctx, url, url.pathname);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceMock.isEnabled.mockReturnValue(true);
});

describe('GET /v1/memory/reviews', () => {
  it('rejects a key without memory:read', async () => {
    const res = await call(
      'GET',
      `/v1/memory/reviews?${SUBJECT_QUERY}`,
      ctxWith(['memory:admin']),
    );
    expect(res.statusCode).toBe(403);
    expect(ipcMock.processPendingMemoryReviewRequest).not.toHaveBeenCalled();
  });

  it('requires agentId, subjectType, and subjectId', async () => {
    const res = await call(
      'GET',
      '/v1/memory/reviews?agentId=agent-1',
      ctxWith(['memory:read']),
    );
    expect(res.statusCode).toBe(400);
    expect(ipcMock.processPendingMemoryReviewRequest).not.toHaveBeenCalled();
  });

  it('returns the pending page for the key-bound subject', async () => {
    ipcMock.processPendingMemoryReviewRequest.mockResolvedValue({
      data: { reviews: [{ id: 'r1' }], total_count: 1 },
    });
    const res = await call(
      'GET',
      `/v1/memory/reviews?${SUBJECT_QUERY}&limit=5`,
      ctxWith(['memory:read']),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      reviews: [{ id: 'r1' }],
      total_count: 1,
    });
    const arg = ipcMock.processPendingMemoryReviewRequest.mock.calls[0]![0];
    expect(arg.subject).toEqual({
      appId: 'default',
      agentId: 'agent-1',
      subjectType: 'user',
      subjectId: 'user-9',
    });
    expect(arg.request.payload).toEqual({ limit: 5 });
  });
});

describe('GET /v1/memory/reviews/{reviewId}', () => {
  it('returns the immutable snapshot record', async () => {
    serviceMock.getReviewDetail.mockResolvedValue({
      id: 'rev-1',
      status: 'pending_review',
      reviewSnapshot: { evidence: [] },
    });
    const res = await call(
      'GET',
      `/v1/memory/reviews/rev-1?${SUBJECT_QUERY}`,
      ctxWith(['memory:read']),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).review.id).toBe('rev-1');
  });

  it('404s when the review is outside the subject boundary', async () => {
    serviceMock.getReviewDetail.mockResolvedValue(null);
    const res = await call(
      'GET',
      `/v1/memory/reviews/rev-x?${SUBJECT_QUERY}`,
      ctxWith(['memory:read']),
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/memory/reviews/{reviewId}/decision', () => {
  it('rejects a key with only memory:read', async () => {
    const res = await call(
      'POST',
      `/v1/memory/reviews/rev-1/decision?${SUBJECT_QUERY}`,
      ctxWith(['memory:read']),
      { decision: 'approve' },
    );
    expect(res.statusCode).toBe(403);
    expect(ipcMock.processMemoryReviewDecisionRequest).not.toHaveBeenCalled();
  });

  it('rejects an invalid decision with 400', async () => {
    const res = await call(
      'POST',
      `/v1/memory/reviews/rev-1/decision?${SUBJECT_QUERY}`,
      ctxWith(['memory:admin']),
      { decision: 'maybe' },
    );
    expect(res.statusCode).toBe(400);
    expect(serviceMock.getReviewDetail).not.toHaveBeenCalled();
  });

  it('applies an approval, deriving the reviewer from the key and stamping the source', async () => {
    serviceMock.getReviewDetail.mockResolvedValue({
      id: 'rev-1',
      status: 'pending_review',
    });
    ipcMock.processMemoryReviewDecisionRequest.mockResolvedValue({
      data: { review: { id: 'rev-1', status: 'applied' } },
    });
    const res = await call(
      'POST',
      `/v1/memory/reviews/rev-1/decision?${SUBJECT_QUERY}`,
      ctxWith(['memory:admin']),
      // A caller-supplied reviewerId must be ignored.
      {
        decision: 'edit_approve',
        editedValue: 'v2',
        reason: 'why',
        reviewerId: 'evil',
      },
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).review.status).toBe('applied');
    const arg = ipcMock.processMemoryReviewDecisionRequest.mock.calls[0]![0];
    expect(arg.request.context).toEqual({
      userId: 'control_api:key-42',
      reviewerIsControlApprover: true,
    });
    expect(arg.request.payload).toEqual({
      review_id: 'rev-1',
      decision: 'edit_approve',
      edited_value: 'v2',
      edited_reason: 'why',
      decision_source: 'control_api',
    });
    expect(arg.subject).toEqual({
      appId: 'default',
      agentId: 'agent-1',
      subjectType: 'user',
      subjectId: 'user-9',
    });
  });

  it('404s for an unknown / foreign review', async () => {
    serviceMock.getReviewDetail.mockResolvedValue(null);
    const res = await call(
      'POST',
      `/v1/memory/reviews/rev-x/decision?${SUBJECT_QUERY}`,
      ctxWith(['memory:admin']),
      { decision: 'approve' },
    );
    expect(res.statusCode).toBe(404);
    expect(ipcMock.processMemoryReviewDecisionRequest).not.toHaveBeenCalled();
  });

  it('409s when the review is no longer pending', async () => {
    serviceMock.getReviewDetail.mockResolvedValue({
      id: 'rev-1',
      status: 'applied',
    });
    const res = await call(
      'POST',
      `/v1/memory/reviews/rev-1/decision?${SUBJECT_QUERY}`,
      ctxWith(['memory:admin']),
      { decision: 'approve' },
    );
    expect(res.statusCode).toBe(409);
    expect(ipcMock.processMemoryReviewDecisionRequest).not.toHaveBeenCalled();
  });

  it('409s when the pending claim is lost mid-decision', async () => {
    serviceMock.getReviewDetail.mockResolvedValue({
      id: 'rev-1',
      status: 'pending_review',
    });
    ipcMock.processMemoryReviewDecisionRequest.mockRejectedValue(
      new Error('pending memory review not found'),
    );
    const res = await call(
      'POST',
      `/v1/memory/reviews/rev-1/decision?${SUBJECT_QUERY}`,
      ctxWith(['memory:admin']),
      { decision: 'approve' },
    );
    expect(res.statusCode).toBe(409);
  });
});
