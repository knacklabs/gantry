import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUTO_AGENT_HARNESS } from '@core/shared/agent-engine.js';
import { listModelCatalogEntries } from '@core/shared/model-catalog.js';
import { listModelRouteProviders } from '@core/shared/model-provider-registry.js';

function makeDraft(): any {
  return {
    agentName: 'Default Agent',
    modelPreset: 'anthropic',
    selectedModel: 'opus',
    agentHarness: AUTO_AGENT_HARNESS,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@clack/prompts');
});

async function loadModelStep(
  selections: string[],
  agentName = 'Default Agent',
) {
  const select = vi.fn(async () => selections.shift() ?? 'sonnet');
  const text = vi.fn(async () => agentName);
  const note = vi.fn();
  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    select,
    text,
    note,
  }));
  const { runModelStep } = await import('@core/cli/setup-flow-core-steps.js');
  return { runModelStep, select, note };
}

describe('setup model step', () => {
  it('keeps guided setup model selections in catalog alias space', async () => {
    const { runModelStep, select } = await loadModelStep([
      'anthropic',
      'sonnet',
    ]);
    const draft = makeDraft();

    const action = await runModelStep(draft);

    expect(action).toEqual({ type: 'next' });
    expect(draft.modelPreset).toBe('anthropic');
    expect(draft.selectedModel).toBe('sonnet');
    expect(draft.agentHarness).toBe(AUTO_AGENT_HARNESS);
    expect(select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Choose agent harness' }),
    );
  });

  it('labels preset and main model/provider prompts distinctly', async () => {
    const { runModelStep, select } = await loadModelStep([
      'anthropic',
      'sonnet',
    ]);

    await runModelStep(makeDraft());

    expect(select.mock.calls[0]?.[0]?.message).toBe(
      'Choose memory/defaults preset',
    );
    expect(select.mock.calls[1]?.[0]?.message).toBe(
      'Choose main model/provider',
    );
  });

  it('does not offer legacy opusplan as a setup model choice', async () => {
    const { runModelStep, select } = await loadModelStep(['anthropic', 'opus']);

    await runModelStep(makeDraft());

    const presetOptions = select.mock.calls[0]?.[0]?.options ?? [];
    expect(
      presetOptions.map((option: { value: string }) => option.value),
    ).not.toContain('memory');
    const options = select.mock.calls[1]?.[0]?.options ?? [];
    expect(
      options.map((option: { value: string }) => option.value),
    ).not.toContain('opusplan');
    expect(
      options.map((option: { value: string }) => option.value),
    ).not.toContain('claude-opus-4-7');
  });

  it('offers OpenRouter chat models from the catalog', async () => {
    const { runModelStep, select } = await loadModelStep([
      'openrouter',
      'kimi',
    ]);
    const draft = makeDraft();

    await runModelStep(draft);

    expect(draft.modelPreset).toBe('openrouter');
    expect(draft.selectedModel).toBe('kimi');
    const options = select.mock.calls[1]?.[0]?.options ?? [];
    expect(options.map((option: { value: string }) => option.value)).toContain(
      'kimi',
    );
  });

  it('keeps the selected preset when the main model uses another preset provider', async () => {
    const { runModelStep, note } = await loadModelStep(['anthropic', 'kimi']);
    const draft = makeDraft();

    const action = await runModelStep(draft);

    expect(action).toEqual({ type: 'next' });
    expect(draft.modelPreset).toBe('anthropic');
    expect(draft.selectedModel).toBe('kimi');
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('Memory will use the Anthropic preset.'),
    );
  });

  it('offers non-preset (DeepAgents-lane) models and keeps the memory preset', async () => {
    // Pick the Anthropic preset (memory cascade) but a non-preset chat model
    // (gpt -> openai). The model offerings include non-preset providers, the
    // chat selection is stored, the preset stays for memory, and a note is shown.
    const { runModelStep, select, note } = await loadModelStep([
      'anthropic',
      'gpt',
    ]);
    const draft = makeDraft();

    const action = await runModelStep(draft);

    expect(action).toEqual({ type: 'next' });
    expect(draft.selectedModel).toBe('gpt');
    expect(draft.agentHarness).toBe(AUTO_AGENT_HARNESS);
    // Non-preset chat model does NOT change the memory/defaults preset.
    expect(draft.modelPreset).toBe('anthropic');
    // The model list now spans providers beyond the selected preset.
    const options = select.mock.calls[1]?.[0]?.options ?? [];
    expect(options.map((option: { value: string }) => option.value)).toContain(
      'gpt',
    );
    // The user is told to configure the non-preset provider's credential.
    expect(note).toHaveBeenCalledTimes(1);
  });

  it('offers at least one chat alias for every chat-capable route provider', async () => {
    const { runModelStep, select } = await loadModelStep(['anthropic', 'opus']);

    await runModelStep(makeDraft());

    const options = select.mock.calls[1]?.[0]?.options ?? [];
    const offeredAliases = new Set(
      options.map((option: { value: string }) => option.value),
    );
    const chatEntries = listModelCatalogEntries().filter((entry) =>
      entry.supportedWorkloads.includes('chat'),
    );
    const chatProviderIds = new Set(
      chatEntries.map((entry) => entry.modelRoute.id),
    );
    expect([...chatProviderIds].sort()).toEqual(
      listModelRouteProviders()
        .filter((provider) =>
          chatEntries.some((entry) => entry.modelRoute.id === provider.id),
        )
        .map((provider) => provider.id)
        .sort(),
    );

    for (const providerId of chatProviderIds) {
      const providerAliases = chatEntries
        .filter((entry) => entry.modelRoute.id === providerId)
        .map((entry) => entry.recommendedAlias);
      expect(
        providerAliases.some((alias) => offeredAliases.has(alias)),
        providerId,
      ).toBe(true);
    }
  });

  it('handles slash flow control before model selection', async () => {
    const { runModelStep, select } = await loadModelStep([], '/back');

    const action = await runModelStep(makeDraft());

    expect(action).toEqual({ type: 'back' });
    expect(select).not.toHaveBeenCalled();
  });

  it.each([
    ['back', { type: 'back' }],
    ['resume', { type: 'resume' }],
    ['cancel', { type: 'cancel' }],
  ])('returns %s from the preset prompt', async (selection, expected) => {
    const { runModelStep, select } = await loadModelStep([selection]);

    const action = await runModelStep(makeDraft());

    expect(action).toEqual(expected);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['back', { type: 'back' }],
    ['resume', { type: 'resume' }],
    ['cancel', { type: 'cancel' }],
  ])('returns %s from the main model prompt', async (selection, expected) => {
    const { runModelStep, select } = await loadModelStep([
      'anthropic',
      selection,
    ]);

    const action = await runModelStep(makeDraft());

    expect(action).toEqual(expected);
    expect(select).toHaveBeenCalledTimes(2);
  });
});
