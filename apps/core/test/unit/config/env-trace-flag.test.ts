import { afterEach, describe, expect, it } from 'vitest';
import { tracePayloadsEnabled } from '@core/runtime/reply-trace.js';

describe('GANTRY_TRACE_PAYLOADS flag', () => {
  const original = process.env.GANTRY_TRACE_PAYLOADS;
  afterEach(() => {
    if (original === undefined) delete process.env.GANTRY_TRACE_PAYLOADS;
    else process.env.GANTRY_TRACE_PAYLOADS = original;
  });

  it('payload capture is opt-in (only "1" enables it)', () => {
    process.env.GANTRY_TRACE_PAYLOADS = '1';
    expect(tracePayloadsEnabled()).toBe(true);
    process.env.GANTRY_TRACE_PAYLOADS = '0';
    expect(tracePayloadsEnabled()).toBe(false);
    process.env.GANTRY_TRACE_PAYLOADS = 'true';
    expect(tracePayloadsEnabled()).toBe(false);
    delete process.env.GANTRY_TRACE_PAYLOADS;
    expect(tracePayloadsEnabled()).toBe(false);
  });
});
