import { afterEach, describe, expect, it, vi } from 'vitest';

function makeDraft(): any {
  return {
    agentName: 'Default Agent',
    modelPreset: 'anthropic',
    selectedModel: 'opus',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@clack/prompts');
});

async function loadModelStep(selections: string[]) {
  const select = vi.fn(async () => selections.shift() ?? 'sonnet');
  const text = vi.fn(async () => 'Default Agent');
  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    select,
    text,
  }));
  const { runModelStep } = await import('@core/cli/setup-flow-core-steps.js');
  return { runModelStep, select };
}

describe('setup model step', () => {
  it('keeps guided setup model selections in catalog alias space', async () => {
    const { runModelStep } = await loadModelStep(['anthropic', 'sonnet']);
    const draft = makeDraft();

    const action = await runModelStep(draft);

    expect(action).toEqual({ type: 'next' });
    expect(draft.modelPreset).toBe('anthropic');
    expect(draft.selectedModel).toBe('sonnet');
  });

  it('does not offer legacy opusplan as a setup model choice', async () => {
    const { runModelStep, select } = await loadModelStep(['anthropic', 'opus']);

    await runModelStep(makeDraft());

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
});
