import { describe, it, expect } from 'vitest';
import {
  createProviderBillingTap,
  firecrawlBillingFailure,
} from '../../../src/shared/provider-billing-transport.js';
describe('provider billing transport', () => {
  it('preserves bytes and extracts an HTTP billing error', () => {
    const found: unknown[] = [];
    const tap = createProviderBillingTap('openai', 429, false, (v) =>
      found.push(v),
    );
    const raw = Buffer.from('{"error":{"code":"credit_balance_exhausted"}}');
    expect(tap.transform(raw)).toBe(raw);
    tap.flush();
    expect(found).toMatchObject([{ reason: 'credits_exhausted' }]);
  });
  it('detects a late split SSE billing error without retaining previous output', () => {
    const found: unknown[] = [];
    const tap = createProviderBillingTap('openrouter', 200, true, (v) =>
      found.push(v),
    );
    tap.transform(Buffer.from('data: {"choices":[]}\n\n'.repeat(9000)));
    tap.transform(
      Buffer.from('data: {"error":{"code":402,"message":"Insufficient'),
    );
    tap.transform(Buffer.from(' credits"}}\n\n'));
    tap.flush();
    expect(found).toHaveLength(1);
  });
  it('excludes ordinary 429 and oversized error envelopes', () => {
    const found: unknown[] = [];
    const tap = createProviderBillingTap('gemini', 429, false, (v) =>
      found.push(v),
    );
    tap.transform(
      Buffer.from('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'),
    );
    tap.flush();
    expect(found).toHaveLength(0);
  });
  it('classifies only failed tools from the configured Firecrawl server', () => {
    const result = {
      isError: true,
      content: [{ type: 'text', text: 'Insufficient credits' }],
    };
    expect(
      firecrawlBillingFailure(
        'firecrawl',
        'firecrawl_search',
        result,
        'server-1',
      ),
    ).toMatchObject({ provider: 'firecrawl', operation: 'firecrawl_search' });
    expect(
      firecrawlBillingFailure(
        'firecrawl-http',
        'firecrawl_search',
        result,
        'server-1',
      ),
    ).toMatchObject({ provider: 'firecrawl', operation: 'firecrawl_search' });
    expect(
      firecrawlBillingFailure(
        'firecrawl-http',
        'other_search',
        result,
        'server-1',
      ),
    ).toBeUndefined();
    expect(
      firecrawlBillingFailure('other', 'firecrawl_search', result, 'server-1'),
    ).toBeUndefined();
    expect(
      firecrawlBillingFailure(
        'firecrawl',
        'firecrawl_search',
        { ...result, isError: false },
        'server-1',
      ),
    ).toBeUndefined();
  });
});
