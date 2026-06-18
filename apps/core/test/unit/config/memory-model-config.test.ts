import { afterEach, describe, expect, it, vi } from 'vitest';

// getMemoryModelConfig resolves the configured memory.llm.models.* aliases
// through resolveMemoryLlmModelSlot, which validates each alias supports the
// matching memory_* workload. These tests prove a new OpenAI-compatible
// provider alias (e.g. `gemini`) is accepted for memory and that the
// search/answer provider (perplexity) is rejected.

async function loadMemoryConfig(snapshot: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock('@core/config/settings/runtime-settings-snapshots.js', () => ({
    readRuntimeMemorySettingsSnapshot: vi.fn(() => snapshot),
  }));
  return import('@core/config/memory.js');
}

describe('getMemoryModelConfig (new OpenAI-compatible providers)', () => {
  afterEach(() => {
    vi.doUnmock('@core/config/settings/runtime-settings-snapshots.js');
    vi.resetModules();
  });

  it('accepts a memory-eligible provider alias (gemini) for the extractor slot', async () => {
    const { getMemoryModelConfig } = await loadMemoryConfig({
      llmExtractorModel: 'gemini',
    });
    const config = getMemoryModelConfig(undefined);
    expect(config.extractor).toBe('gemini-2.5-pro');
    expect(config.modelProfiles.extractor).toMatchObject({
      alias: 'gemini',
      runnerModel: 'gemini-2.5-pro',
      responseFamily: 'openai',
      modelRoute: 'gemini',
    });
  });

  it('accepts a memory-eligible provider alias (groq) across all memory slots', async () => {
    const { getMemoryModelConfig } = await loadMemoryConfig({
      llmExtractorModel: 'groq',
      llmDreamingModel: 'groq',
      llmConsolidationModel: 'groq',
    });
    const config = getMemoryModelConfig(undefined);
    expect(config.extractor).toBe('llama-3.3-70b-versatile');
    expect(config.dreaming).toBe('llama-3.3-70b-versatile');
    expect(config.consolidation).toBe('llama-3.3-70b-versatile');
  });

  it('rejects the search/answer provider alias (perplexity) for memory', async () => {
    const { getMemoryModelConfig } = await loadMemoryConfig({
      llmExtractorModel: 'perplexity',
    });
    expect(() => getMemoryModelConfig(undefined)).toThrow(
      /not eligible for memory extraction|is not usable for memory_extractor/,
    );
  });
});
