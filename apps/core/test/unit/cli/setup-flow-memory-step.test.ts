import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@clack/prompts');
});

function makeDraft(): any {
  return {
    memoryEnabled: undefined,
    embeddingsEnabled: undefined,
    dreamingEnabled: true,
  };
}

async function loadMemoryStep(input: {
  confirms: boolean[];
  selects?: string[];
  progressAction?: 'next' | 'back' | 'resume' | 'cancel';
}) {
  const confirms = [...input.confirms];
  const selects = [...(input.selects ?? [input.progressAction ?? 'next'])];
  const confirm = vi.fn(async () => confirms.shift() ?? false);
  const note = vi.fn();
  const select = vi.fn(async () => selects.shift() ?? 'next');
  vi.doMock('@clack/prompts', () => ({
    confirm,
    isCancel: () => false,
    note,
    select,
  }));
  const { runMemoryStep } = await import('@core/cli/setup-flow-core-steps.js');
  return { runMemoryStep, confirm, note, select };
}

describe('setup memory step', () => {
  it('defaults memory on and semantic search off', async () => {
    const { runMemoryStep, confirm } = await loadMemoryStep({
      confirms: [true, true],
    });
    const draft = makeDraft();

    await expect(runMemoryStep(draft)).resolves.toEqual({ type: 'next' });

    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      message: 'Enable memory?',
      initialValue: true,
    });
    expect(confirm.mock.calls[1]?.[0]).toMatchObject({
      message:
        'Enable semantic search? Requires an OpenAI API key for embeddings',
      initialValue: false,
    });
    expect(draft.memoryEnabled).toBe(true);
    expect(draft.embeddingsEnabled).toBe(true);
    expect(draft.dreamingEnabled).toBe(true);
  });

  it('does not ask for embeddings when memory is off', async () => {
    const { runMemoryStep, confirm } = await loadMemoryStep({
      confirms: [false],
    });
    const draft = makeDraft();

    await expect(runMemoryStep(draft)).resolves.toEqual({ type: 'next' });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(draft.memoryEnabled).toBe(false);
    expect(draft.embeddingsEnabled).toBe(false);
    expect(draft.dreamingEnabled).toBe(true);
  });

  it('asks before keeping cross-provider memory credentials and can disable memory', async () => {
    const { runMemoryStep, confirm, note, select } = await loadMemoryStep({
      confirms: [true],
      selects: ['disable', 'next'],
    });
    const draft = { ...makeDraft(), selectedModel: 'perplexity' };

    await expect(runMemoryStep(draft)).resolves.toEqual({ type: 'next' });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith(
      'Memory models run on Anthropic and require its credential.',
    );
    expect(select.mock.calls[0]?.[0]).toMatchObject({
      message: 'Use memory with this extra credential?',
      initialValue: 'keep',
    });
    expect(select.mock.calls[0]?.[0].options[0]).toMatchObject({
      label: 'Keep memory on (needs Anthropic credential)',
    });
    expect(draft.memoryEnabled).toBe(false);
    expect(draft.embeddingsEnabled).toBe(false);
  });

  it('does not ask for a memory credential choice when memory stays on the chat provider', async () => {
    const { runMemoryStep, note, select } = await loadMemoryStep({
      confirms: [true, false],
      selects: ['next'],
    });
    const draft = { ...makeDraft(), selectedModel: 'opus' };

    await expect(runMemoryStep(draft)).resolves.toEqual({ type: 'next' });

    expect(note).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0]?.[0]).toMatchObject({
      message: 'Use these memory settings?',
    });
    expect(draft.memoryEnabled).toBe(true);
    expect(draft.embeddingsEnabled).toBe(false);
  });

  it.each([
    ['back', { type: 'back' }],
    ['resume', { type: 'resume' }],
  ] as const)(
    'returns %s from the memory progress prompt',
    async (choice, expected) => {
      const { runMemoryStep, select } = await loadMemoryStep({
        confirms: [true, false],
        progressAction: choice,
      });

      await expect(runMemoryStep(makeDraft())).resolves.toEqual(expected);
      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Use these memory settings?',
        }),
      );
    },
  );
});
