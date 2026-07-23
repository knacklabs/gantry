import { describe, expect, it } from 'vitest';

import {
  openAiBatchIdFromPath,
  openAiFileContentIdFromPath,
} from '@core/adapters/llm/anthropic-claude-agent/gantry-model-gateway-routing.js';

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
