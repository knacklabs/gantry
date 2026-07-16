import { describe, expect, it, vi } from 'vitest';

const langfuseTracingMock = vi.hoisted(() => {
  const state = {
    activeSpanId: undefined as string | undefined,
    updates: [] as Record<string, unknown>[],
    starts: [] as Array<{ readonly name: string; readonly options?: Record<string, unknown> }>,
  };
  return {
    state,
    propagateAttributes: vi.fn(async (_attributes: unknown, fn: () => Promise<unknown>) => await fn()),
    setLangfuseTracerProvider: vi.fn(),
    startActiveObservation: vi.fn(
      async (
        name: string,
        fn: (observation: {
          update(attributes: Record<string, unknown>): void;
          otelSpan: { setAttributes(attributes: Record<string, unknown>): void };
        }) => Promise<unknown>,
        options?: Record<string, unknown>,
      ) => {
        state.starts.push({ name, options });
        return await fn({
          update: (attributes) => state.updates.push(attributes),
          otelSpan: { setAttributes: () => undefined },
        });
      },
    ),
  };
});

vi.mock('@langfuse/tracing', () => ({
  LangfuseOtelSpanAttributes: {
    TRACE_NAME: 'langfuse.trace.name',
    TRACE_TAGS: 'langfuse.trace.tags',
  },
  getActiveSpanId: () => langfuseTracingMock.state.activeSpanId,
  propagateAttributes: langfuseTracingMock.propagateAttributes,
  setLangfuseTracerProvider: langfuseTracingMock.setLangfuseTracerProvider,
  startActiveObservation: langfuseTracingMock.startActiveObservation,
}));

describe('Gantry Langfuse observability', () => {
  it('uses LANGFUSE_PAYLOAD_PREVIEW_CHARS for preview payloads', async () => {
    const previousTracing = process.env.LANGFUSE_TRACING_ENABLED;
    const previousCapture = process.env.LANGFUSE_CAPTURE_PAYLOADS;
    const previousPreviewChars = process.env.LANGFUSE_PAYLOAD_PREVIEW_CHARS;
    process.env.LANGFUSE_TRACING_ENABLED = 'true';
    process.env.LANGFUSE_CAPTURE_PAYLOADS = 'preview';
    process.env.LANGFUSE_PAYLOAD_PREVIEW_CHARS = '4000';
    langfuseTracingMock.state.updates = [];
    try {
      const { observeGantryModelCall } = await import('../src/tasks/model-observability.js');
      await observeGantryModelCall({
        operationName: 'preview-test',
        modelCallType: 'generation',
        provider: 'test',
        model: 'test-model',
        input: 'x'.repeat(4500),
      }, async () => ({ ok: true }));

      const input = langfuseTracingMock.state.updates.find((update) => update.input)?.input as { preview?: string };
      expect(input.preview).toHaveLength(4000);
    } finally {
      restoreEnv('LANGFUSE_TRACING_ENABLED', previousTracing);
      restoreEnv('LANGFUSE_CAPTURE_PAYLOADS', previousCapture);
      restoreEnv('LANGFUSE_PAYLOAD_PREVIEW_CHARS', previousPreviewChars);
    }
  });

  it('attaches an incoming remote parent span context', async () => {
    const previousTracing = process.env.LANGFUSE_TRACING_ENABLED;
    process.env.LANGFUSE_TRACING_ENABLED = 'true';
    langfuseTracingMock.state.starts = [];
    try {
      const { observeGantryModelCall } = await import('../src/tasks/model-observability.js');
      await observeGantryModelCall({
        operationName: 'child-test',
        modelCallType: 'generation',
        provider: 'test',
        model: 'test-model',
        parentSpanContext: {
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
        },
      }, async () => ({ ok: true }));

      expect(langfuseTracingMock.state.starts[0]?.options).toMatchObject({
        parentSpanContext: {
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          traceFlags: 1,
          isRemote: true,
        },
      });
    } finally {
      restoreEnv('LANGFUSE_TRACING_ENABLED', previousTracing);
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
