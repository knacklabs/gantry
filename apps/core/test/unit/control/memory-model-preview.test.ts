import { describe, expect, it } from 'vitest';

import { memoryModelPreview } from '@core/control/server/routes/models.js';
import type {
  ControlModelDefaultSlot,
  ControlRouteContext,
} from '@core/control/server/handler-context.js';
import {
  resolveModelSelectionForWorkload,
  type ModelWorkload,
} from '@core/shared/model-catalog.js';
import {
  DEEPAGENTS_ENGINE,
  DEFAULT_AGENT_ENGINE,
} from '@core/shared/agent-engine.js';

function slotFor(
  alias: string,
  workload: ModelWorkload,
): ControlModelDefaultSlot {
  const resolved = resolveModelSelectionForWorkload(alias, workload);
  if (!resolved.ok) throw new Error(`fixture alias not resolvable: ${alias}`);
  return {
    configuredAlias: alias,
    effectiveAlias: resolved.alias,
    source: 'preset-managed',
    workload,
    modelEntry: resolved.entry,
  };
}

function ctxWith(extractorAlias: string): ControlRouteContext {
  const extractor = slotFor(extractorAlias, 'memory_extractor');
  return {
    getModelDefaults: () => ({
      defaults: {
        chat: extractor,
        oneTime: extractor,
        recurring: extractor,
        memoryExtractor: extractor,
        memoryDreaming: extractor,
        memoryConsolidation: extractor,
      },
    }),
  } as unknown as ControlRouteContext;
}

describe('memoryModelPreview', () => {
  it('derives the SDK engine + native_sdk lane from an anthropic model', () => {
    const result = memoryModelPreview(ctxWith('haiku'), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({
      target: 'memory',
      task: 'extractor',
      engine: DEFAULT_AGENT_ENGINE,
      engineLabel: 'Anthropic SDK',
      responseFamily: 'anthropic',
      diagnosticLane: 'native_sdk',
    });
  });

  it('derives the deepagents engine + openai_direct lane from an openai model', () => {
    const result = memoryModelPreview(ctxWith('gpt'), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({
      engine: DEEPAGENTS_ENGINE,
      engineLabel: 'DeepAgents',
      responseFamily: 'openai',
      diagnosticLane: 'openai_direct',
    });
  });

  it('treats a new OpenAI-compatible provider (gemini) as memory-eligible on the openai_direct lane', () => {
    // slotFor throws if the alias is not resolvable for the memory workload, so
    // building this fixture at all proves gemini is now memory-eligible. The
    // preview must report the DeepAgents/openai_direct lane for it.
    const result = memoryModelPreview(ctxWith('gemini'), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({
      engine: DEEPAGENTS_ENGINE,
      engineLabel: 'DeepAgents',
      responseFamily: 'openai',
      diagnosticLane: 'openai_direct',
    });
  });

  it('reports openai_direct for OpenRouter despite its nominal anthropic family', () => {
    // OpenRouter runs on the DeepAgents engine and speaks chat/completions, so
    // its memory lane is openai_direct even though responseFamily is 'anthropic'
    // — the diagnostic must match the route-aware client's provider-first dispatch.
    const result = memoryModelPreview(ctxWith('kimi'), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({
      engine: DEEPAGENTS_ENGINE,
      engineLabel: 'DeepAgents',
      responseFamily: 'anthropic',
      diagnosticLane: 'openai_direct',
    });
  });
});
