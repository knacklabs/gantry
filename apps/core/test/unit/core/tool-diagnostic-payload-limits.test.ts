import { afterEach, expect, it } from 'vitest';
import { diag } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';

import { observeGatewayCall } from '@core/adapters/llm/observability/genai-spans.js';
import {
  initTracing,
  shutdownTracing,
  startTurnSpan,
} from '@core/infrastructure/observability/tracing.js';

// Fix owner: tool-diagnostics-bound-payloads-two-diff.
afterEach(async () => {
  await shutdownTracing();
  diag.disable();
});

it.each([false, true])(
  'includes truncation markers within tool diagnostic limits (streaming: %s)',
  (streaming) => {
    const exporter = new InMemorySpanExporter();
    initTracing(
      { enabled: true, captureContent: true, sampleRate: 1 },
      exporter,
    );
    const runId = `payload-limits-${streaming}`;
    const turn = startTurnSpan({ runId, agentName: 'Payload limits' });
    const observation = observeGatewayCall({
      token: { runId },
      providerId: 'openai',
      upstreamUrl: new URL('https://llm.example/v1/chat/completions'),
      requestBody: Buffer.from(
        JSON.stringify({ model: 'fixture', stream: streaming, messages: [] }),
      ),
    })!;
    const tool = {
      index: 0,
      id: 'payload-call',
      type: 'function',
      function: {
        name: 'Search',
        arguments: JSON.stringify({ query: 'x'.repeat(20_000) }),
      },
    };
    const choice = {
      [streaming ? 'delta' : 'message']: { tool_calls: [tool] },
      finish_reason: 'tool_calls',
    };
    if (streaming) {
      observation
        .streamTapFor('text/event-stream', 200)!
        .transform(
          Buffer.from(
            `data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`,
          ),
        );
      observation.finish({ status: 200 });
    } else {
      observation.finish({ status: 200, responseJson: { choices: [choice] } });
    }
    turn.end('success');
    const span = exporter
      .getFinishedSpans()
      .find(
        (candidate) =>
          candidate.attributes['gen_ai.operation.name'] === 'execute_tool',
      );
    expect(span).toBeDefined();
    const encoded = String(span!.attributes['gen_ai.tool.call.arguments']);
    expect(encoded.length).toBeLessThanOrEqual(16_000);
    const payload = JSON.parse(encoded) as { query: string };
    // The 16,000-character budget shrinks once to fit the enclosing JSON.
    // Its marker must be included in that 8,000-character string allowance.
    expect(payload.query).toBe(
      `${'x'.repeat(8_000 - '…[truncated]'.length)}…[truncated]`,
    );
  },
);
