import { afterEach, describe, expect, it, vi } from 'vitest';

import { log } from '@core/adapters/llm/anthropic-claude-agent/runner/logging.js';

describe('Claude runner logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts provider session handles from direct runner logs', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    log(
      'resume claude-session-direct-secret and provider-session:direct-secret',
    );

    const output = consoleError.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join('');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('claude-session-direct-secret');
    expect(output).not.toContain('provider-session:direct-secret');
  });

  it('redacts non-shape session ids when logged under sensitive field names', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    log(
      'stream output {"newSessionId":"sess-short","externalSessionId":"external-short"} latestProviderSessionId: latest-short session_id snake-short sessionId=sess-inline-short',
    );

    const output = consoleError.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join('');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('sess-short');
    expect(output).not.toContain('external-short');
    expect(output).not.toContain('latest-short');
    expect(output).not.toContain('snake-short');
    expect(output).not.toContain('sess-inline-short');
  });
});
