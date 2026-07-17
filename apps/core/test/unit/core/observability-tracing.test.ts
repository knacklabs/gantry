import { diag } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ATTR_COMPLETION,
  ATTR_PROMPT,
  TRACE_CONTENT_MAX_CHARS,
  boundedContent,
  getTurnSpan,
  initTracing,
  parseOtlpHeaders,
  shutdownTracing,
  startTurnSpan,
  tracingEnabled,
} from '@core/infrastructure/observability/tracing.js';
import { createSpawnTurnTracker } from '@core/infrastructure/observability/spawn-turn-tracker.js';
import {
  currentLogContext,
  withLogContext,
} from '@core/infrastructure/logging/logger.js';

afterEach(async () => {
  await shutdownTracing();
  diag.disable();
});

describe('observability tracing', () => {
  it('parses OTLP headers and ignores empty or malformed entries', () => {
    expect(parseOtlpHeaders('k=v,k2=v2')).toEqual({ k: 'v', k2: 'v2' });
    expect(parseOtlpHeaders(' k = value with spaces , k2 = v=2 ')).toEqual({
      k: 'value with spaces',
      k2: 'v=2',
    });
    expect(parseOtlpHeaders(undefined)).toBeUndefined();
    expect(parseOtlpHeaders('')).toBeUndefined();
    expect(parseOtlpHeaders('   ')).toBeUndefined();
    expect(parseOtlpHeaders('missing-separator,=missing-key')).toBeUndefined();
  });

  it('bounds content only after the 16k character limit', () => {
    const atLimit = 'a'.repeat(TRACE_CONTENT_MAX_CHARS);
    const overLimit = `${atLimit}b`;

    expect(boundedContent(atLimit)).toBe(atLimit);
    expect(boundedContent(overLimit)).toBe(`${atLimit}…[truncated]`);
  });

  it('keeps an enabled turn span in the registry until it ends', () => {
    const exporter = new InMemorySpanExporter();
    initTracing(
      {
        enabled: true,
        captureContent: true,
        sampleRate: 1,
        environment: 'test',
      },
      exporter,
    );

    const handle = startTurnSpan({
      runId: 'run-1',
      appId: 'app-1',
      agentId: 'agent-1',
      agentName: 'Researcher',
      conversationId: 'conversation-1',
      threadId: 'thread-1',
      jobId: 'job-1',
      userId: 'user-1',
    });
    const activeSpan = getTurnSpan('run-1');

    expect(activeSpan).toBeDefined();
    expect(handle.traceId).toBe(activeSpan?.spanContext().traceId);
    handle.setInput('hello');
    handle.setOutput('world');
    handle.end('success');
    handle.end('error', 'ignored duplicate end');

    expect(getTurnSpan('run-1')).toBeUndefined();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('invoke_agent Researcher');
    expect(spans[0]?.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'Researcher',
      'gen_ai.agent.id': 'agent-1',
      'session.id': 'conversation-1',
      'user.id': 'user-1',
      'gantry.app_id': 'app-1',
      'gantry.run_id': 'run-1',
      'gantry.job_id': 'job-1',
      'gantry.thread_id': 'thread-1',
      'gantry.turn_outcome': 'success',
      [ATTR_PROMPT]: JSON.stringify([{ role: 'user', content: 'hello' }]),
      [ATTR_COMPLETION]: JSON.stringify([
        { role: 'assistant', content: 'world' },
      ]),
    });
  });

  it('does not capture turn content when captureContent is false', () => {
    const exporter = new InMemorySpanExporter();
    initTracing(
      { enabled: true, captureContent: false, sampleRate: 1 },
      exporter,
    );

    const handle = startTurnSpan({ runId: 'run-2', agentName: 'Writer' });
    handle.setInput('secret input');
    handle.setOutput('secret output');
    handle.end('success');

    expect(exporter.getFinishedSpans()[0]?.attributes).not.toHaveProperty(
      ATTR_PROMPT,
    );
    expect(exporter.getFinishedSpans()[0]?.attributes).not.toHaveProperty(
      ATTR_COMPLETION,
    );
  });

  it('returns a safe no-op handle when tracing is disabled', () => {
    const exporter = new InMemorySpanExporter();
    initTracing(
      { enabled: false, captureContent: true, sampleRate: 1 },
      exporter,
    );

    const handle = startTurnSpan({ runId: 'disabled', agentName: 'Agent' });

    expect(tracingEnabled()).toBe(false);
    expect(handle.traceId).toBeUndefined();
    expect(getTurnSpan('disabled')).toBeUndefined();
    expect(() => {
      handle.setInput('input');
      handle.setOutput('output');
      handle.end('error', 'failure');
    }).not.toThrow();
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('carries the real trace id and rotates it for a continuation', async () => {
    const exporter = new InMemorySpanExporter();
    initTracing(
      { enabled: true, captureContent: false, sampleRate: 1 },
      exporter,
    );
    const observedTraceIds: Array<string | undefined> = [];
    const tracker = createSpawnTurnTracker(
      'Researcher',
      {
        runId: 'run-continuation',
        appId: 'app-1',
        agentId: 'agent-1',
        prompt: 'hello',
      },
      async () => {
        observedTraceIds.push(currentLogContext()?.traceId);
      },
    );
    const firstTraceId = tracker.traceId();

    expect(firstTraceId).toMatch(/^[0-9a-f]{32}$/);
    await withLogContext(
      {
        runId: tracker.correlationId,
        appId: 'app-1',
        agentId: 'agent-1',
        traceId: firstTraceId,
      },
      async () => {
        await tracker.onOutput?.({
          status: 'success',
          result: 'first',
          continuedByFollowup: true,
        });
        expect(currentLogContext()?.traceId).toBe(tracker.traceId());
        expect(tracker.traceId()).not.toBe(firstTraceId);
        tracker.finish({ status: 'success', result: 'second' });
      },
    );

    expect(observedTraceIds).toEqual([firstTraceId]);
    expect(exporter.getFinishedSpans()).toHaveLength(2);
  });
});
