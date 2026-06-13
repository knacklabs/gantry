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
});
