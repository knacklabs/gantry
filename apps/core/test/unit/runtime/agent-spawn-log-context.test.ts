import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it } from 'vitest';

import { currentLogContext } from '@core/infrastructure/logging/logger.js';
import {
  initTracing,
  shutdownTracing,
} from '@core/infrastructure/observability/tracing.js';
import { runSpawnWithLogContext } from '@core/infrastructure/observability/spawn-log-context.js';
import { resolveAgentSpawnLogContext } from '@core/runtime/agent-spawn-identity.js';

afterEach(async () => {
  await shutdownTracing();
});

describe('agent spawn log context', () => {
  it('carries canonical run, app, agent, and trace ids', async () => {
    const exporter = new InMemorySpanExporter();
    initTracing(
      { enabled: true, captureContent: false, sampleRate: 1 },
      exporter,
    );
    let observed: ReturnType<typeof currentLogContext>;

    const context = resolveAgentSpawnLogContext(
      {
        name: 'Researcher',
        folder: 'researcher',
        agentId: 'agent:canonical-researcher',
        trigger: '@researcher',
        added_at: '2026-07-17T00:00:00.000Z',
      },
      {
        runId: 'run-spawn-context',
        appId: 'app-spawn-context',
        workspaceFolder: 'researcher',
        chatJid: 'tg:research',
        prompt: 'research this',
      },
    );
    await runSpawnWithLogContext(
      {
        ...context,
        onOutput: undefined,
      },
      async () => {
        observed = currentLogContext();
        return { status: 'success', result: 'done' };
      },
    );

    const span = exporter.getFinishedSpans()[0];
    expect(observed).toEqual({
      runId: 'run-spawn-context',
      appId: 'app-spawn-context',
      agentId: 'agent:canonical-researcher',
      traceId: span?.spanContext().traceId,
    });
    expect(observed?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span?.attributes).toMatchObject({
      'gantry.run_id': 'run-spawn-context',
      'gantry.app_id': 'app-spawn-context',
      'gen_ai.agent.id': 'agent:canonical-researcher',
    });
  });

  it('uses the outer interactive run only for log and trace correlation', async () => {
    const exporter = new InMemorySpanExporter();
    initTracing(
      { enabled: true, captureContent: false, sampleRate: 1 },
      exporter,
    );
    let observed: ReturnType<typeof currentLogContext>;

    const context = resolveAgentSpawnLogContext(
      {
        name: 'Researcher',
        folder: 'researcher',
        trigger: '@researcher',
        added_at: '2026-07-17T00:00:00.000Z',
      },
      {
        appId: 'app-spawn-context',
        workspaceFolder: 'researcher',
        chatJid: 'tg:research',
        prompt: 'research this',
      },
      'run-interactive-context',
    );
    expect(context.turn).not.toHaveProperty('runId');

    await runSpawnWithLogContext(
      {
        ...context,
        onOutput: undefined,
      },
      async () => {
        observed = currentLogContext();
        return { status: 'success', result: 'done' };
      },
    );

    expect(observed?.runId).toBe('run-interactive-context');
    expect(exporter.getFinishedSpans()[0]?.attributes).toMatchObject({
      'gantry.run_id': 'run-interactive-context',
    });
  });
});
