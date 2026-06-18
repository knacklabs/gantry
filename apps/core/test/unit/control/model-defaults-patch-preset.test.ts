import { describe, expect, it } from 'vitest';

import { providersSelectedByPatch } from '@core/control/server/routes/models.js';
import type {
  ControlModelDefaultSlot,
  ControlRouteContext,
} from '@core/control/server/handler-context.js';
import {
  resolveModelSelectionForWorkload,
  type ModelWorkload,
} from '@core/shared/model-catalog.js';

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

function defaultsWith(
  chatAlias: string,
  memoryAlias: string,
): ReturnType<ControlRouteContext['getModelDefaults']> {
  const chat = slotFor(chatAlias, 'chat');
  const oneTime = slotFor(chatAlias, 'one_time_job');
  const recurring = slotFor(chatAlias, 'recurring_job');
  const memory = slotFor(memoryAlias, 'memory_extractor');
  return {
    defaults: {
      chat,
      oneTime,
      recurring,
      memoryExtractor: memory,
      memoryDreaming: memory,
      memoryConsolidation: memory,
    },
  } as unknown as ReturnType<ControlRouteContext['getModelDefaults']>;
}

describe('providersSelectedByPatch', () => {
  it('does not throw when the chat default is a DeepAgents model and the body omits preset', () => {
    // groq resolves to the groq (DeepAgents-lane) provider, whose provider id is
    // not a model preset; the patch preflight selection must guard rather than
    // letting getModelPreset throw and turn the PATCH into a 500. groq memory
    // slots keep every workload on the DeepAgents lane, so none have a preset.
    const defaults = defaultsWith('groq', 'groq');
    expect(() => providersSelectedByPatch({}, defaults)).not.toThrow();
    // DeepAgents-lane providers have no preset to preflight, so none are selected.
    expect(providersSelectedByPatch({}, defaults)).toEqual([]);
  });

  it('still selects the anthropic preset for an anthropic chat default', () => {
    const defaults = defaultsWith('sonnet', 'haiku');
    expect(providersSelectedByPatch({}, defaults)).toEqual(['anthropic']);
  });
});
