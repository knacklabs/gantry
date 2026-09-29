import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { registerSlackMessageActionHandler } from '@core/channels/slack/channel-message-action-handler.js';
import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import { getGantryOpenApiDocument } from '@core/control/server/openapi.js';
import { handleJobRoutes } from '@core/control/server/routes/jobs.js';
import { handleMemoryRoutes } from '@core/control/server/routes/memory.js';

const memory = vi.hoisted(() => ({
  getReviewDetail: vi.fn(async () => ({ status: 'pending_review' })),
  processMemoryReviewDecisionRequest: vi.fn(async () => ({
    data: { review: {} },
  })),
}));

vi.mock('@core/memory/app-memory-service.js', () => ({
  AppMemoryService: {
    getInstance: () => ({
      isEnabled: () => true,
      getReviewDetail: memory.getReviewDetail,
    }),
  },
}));
vi.mock('@core/memory/memory-review-ipc.js', () => ({
  processMemoryReviewDecisionRequest: memory.processMemoryReviewDecisionRequest,
}));

function response(): ServerResponse & { body: string } {
  return {
    statusCode: 0,
    body: '',
    setHeader() {},
    end(chunk?: unknown) {
      this.body += chunk ? String(chunk) : '';
      return this;
    },
  } as unknown as ServerResponse & { body: string };
}

function request(method: string, body?: unknown): IncomingMessage {
  const req = Readable.from(
    body === undefined ? [] : [JSON.stringify(body)],
  ) as IncomingMessage;
  req.method = method;
  req.headers = { authorization: 'Bearer test-token' };
  return req;
}

function context(scope: string): ControlRouteContext {
  return {
    keys: [
      {
        kid: 'key',
        tokenHash: createHash('sha256').update('test-token').digest(),
        scopes: new Set([scope]),
        appId: 'default',
      },
    ],
  } as unknown as ControlRouteContext;
}

describe('small API action and request contracts', () => {
  it('dispatches only indexed Slack message buttons', () => {
    let registered: string | RegExp | undefined;
    registerSlackMessageActionHandler({
      action: (name) => {
        registered = name;
      },
      client: { chat: { postEphemeral: vi.fn(), update: vi.fn() } },
    });
    expect(registered).toBeInstanceOf(RegExp);
    const buttonId = 'gantry_message_action:0';
    expect((registered as RegExp).test(buttonId)).toBe(true);
    expect(
      (registered as RegExp).test(buttonId.slice(0, buttonId.lastIndexOf(':'))),
    ).toBe(false);
  });

  it('rejects unexpected fields on simple memory decisions', async () => {
    const path =
      '/v1/memory/reviews/rev-1/decision?agentId=agent-1&subjectType=user&subjectId=user-1';
    const url = new URL(`http://localhost${path}`);
    const res = response();
    await handleMemoryRoutes(
      request('POST', { decision: 'approve', extra: 'value' }),
      res,
      context('memory:admin'),
      url,
      url.pathname,
    );
    expect(res.statusCode).toBe(400);
  });

  it('filters job events only with the documented query parameter', async () => {
    const path = '/v1/jobs/job-1/events?run=chosen';
    const url = new URL(`http://localhost${path}`);
    const listJobEvents = vi.fn(async () => ({ events: [] }));
    const res = response();
    await handleJobRoutes(
      request('GET'),
      res,
      {
        ...context('jobs:read'),
        jobManagement: { listJobEvents },
      } as unknown as ControlRouteContext,
      url,
      url.pathname,
    );
    expect(res.statusCode).toBe(200);
    expect(listJobEvents).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'chosen' }),
    );
    expect(
      getGantryOpenApiDocument().paths['/v1/jobs/{jobId}/events']?.get
        .parameters,
    ).toHaveLength(6);
  });
});
