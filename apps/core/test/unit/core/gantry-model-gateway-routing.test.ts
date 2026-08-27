import { describe, expect, it } from 'vitest';

import {
  openAiBatchIdFromPath,
  openAiFileContentIdFromPath,
} from '@core/adapters/llm/anthropic-claude-agent/gantry-model-gateway-routing.js';
import {
  inferredRetryAfterMs,
  shouldForwardGatewayResponseHeader,
} from '@core/adapters/llm/anthropic-claude-agent/gantry-model-gateway-http.js';

describe('OpenAI gateway batch route parsing', () => {
  it('extracts exact batch and file-content resource ids', () => {
    expect(openAiBatchIdFromPath('/v1/batches/batch_own')).toBe('batch_own');
    expect(openAiBatchIdFromPath('/v1/batches')).toBeUndefined();
    expect(
      openAiBatchIdFromPath('/v1/batches/batch_own/results'),
    ).toBeUndefined();

    expect(openAiFileContentIdFromPath('/v1/files/file_own/content')).toBe(
      'file_own',
    );
    expect(openAiFileContentIdFromPath('/v1/files/file_own')).toBeUndefined();
    expect(openAiFileContentIdFromPath('/v1/files//content')).toBeUndefined();
  });
});

describe('model gateway response headers', () => {
  it('forwards provider retry timing without exposing arbitrary headers', () => {
    expect(shouldForwardGatewayResponseHeader('Retry-After')).toBe(true);
    expect(shouldForwardGatewayResponseHeader('retry-after-ms')).toBe(true);
    expect(shouldForwardGatewayResponseHeader('set-cookie')).toBe(false);
  });

  it('recovers retry timing from an OpenAI 429 body when headers omit it', async () => {
    const response = new Response(
      JSON.stringify({
        error: { message: 'Rate limit reached. Please try again in 4.626s.' },
      }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    );
    await expect(inferredRetryAfterMs(response)).resolves.toBe(4626);
  });

  it('does not replace an upstream retry header', async () => {
    const response = new Response('Please try again in 1s.', {
      status: 429,
      headers: { 'retry-after': '9' },
    });
    await expect(inferredRetryAfterMs(response)).resolves.toBeUndefined();
  });
});
