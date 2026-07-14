import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUTO_AGENT_HARNESS } from '@core/shared/agent-engine.js';
import { listModelCatalogEntries } from '@core/shared/model-catalog.js';
import { listModelRouteProviders } from '@core/shared/model-provider-registry.js';

function makeDraft(): any {
  return {
    agentName: 'Default Agent',
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
    const { runModelStep, select } = await loadModelStep(['sonnet']);
    const draft = makeDraft();

    const action = await runModelStep(draft);

    expect(action).toEqual({ type: 'next' });
    expect(draft.selectedModel).toBe('sonnet');
    expect(draft.agentHarness).toBe(AUTO_AGENT_HARNESS);
    expect(select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Choose agent harness' }),
    );
  });

  it('asks for the main chat model directly', async () => {
    const { runModelStep, select } = await loadModelStep(['sonnet']);

    await runModelStep(makeDraft());

    expect(select.mock.calls[0]?.[0]?.message).toBe(
      'Choose your main chat model',
    );
  });

  it('does not offer legacy opusplan as a setup model choice', async () => {
    const { runModelStep, select } = await loadModelStep(['opus']);

    await runModelStep(makeDraft());

    const options = select.mock.calls[0]?.[0]?.options ?? [];
    expect(
      options.map((option: { value: string }) => option.value),
    ).not.toContain('opusplan');
    expect(
      options.map((option: { value: string }) => option.value),
    ).not.toContain('claude-opus-4-7');
  });

  it('offers OpenRouter chat models from the catalog', async () => {
    const { runModelStep, select } = await loadModelStep(['kimi']);
    const draft = makeDraft();

    await runModelStep(draft);

    expect(draft.selectedModel).toBe('kimi');
    const options = select.mock.calls[0]?.[0]?.options ?? [];
    expect(options.map((option: { value: string }) => option.value)).toContain(
      'kimi',
    );
  });

  it('describes memory defaults from the selected provider', async () => {
    const { runModelStep, note } = await loadModelStep(['kimi']);
    const draft = makeDraft();

    const action = await runModelStep(draft);

    expect(action).toEqual({ type: 'next' });
    expect(draft.selectedModel).toBe('kimi');
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        'Memory LLM defaults derive from openrouter: kimi, kimi, kimi.',
      ),
    );
  });

  it('offers DeepAgents-lane models and derives memory from that provider', async () => {
    const { runModelStep, select, note } = await loadModelStep(['gpt']);
    const draft = makeDraft();

    const action = await runModelStep(draft);

    expect(action).toEqual({ type: 'next' });
    expect(draft.selectedModel).toBe('gpt');
    expect(draft.agentHarness).toBe(AUTO_AGENT_HARNESS);
    const options = select.mock.calls[0]?.[0]?.options ?? [];
    expect(options.map((option: { value: string }) => option.value)).toContain(
      'gpt',
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        'Memory LLM defaults derive from openai: gpt-mini, gpt-mini, gpt-mini.',
      ),
    );
  });

  it('offers at least one chat alias for every chat-capable route provider', async () => {
    const { runModelStep, select } = await loadModelStep(['opus']);

    await runModelStep(makeDraft());

    const options = select.mock.calls[0]?.[0]?.options ?? [];
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
  ])('returns %s from the model prompt', async (selection, expected) => {
    const { runModelStep, select } = await loadModelStep([selection]);

    const action = await runModelStep(makeDraft());

    expect(action).toEqual(expected);
    expect(select).toHaveBeenCalledTimes(1);
  });
});
