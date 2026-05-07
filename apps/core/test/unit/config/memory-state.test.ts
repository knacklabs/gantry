import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadMemoryState(snapshot: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock('@core/config/settings/runtime-settings.js', () => ({
    readRuntimeMemorySettingsSnapshot: vi.fn(() => snapshot),
  }));
  return import('@core/config/memory-state.js');
}

describe('runtime memory state', () => {
  afterEach(() => {
    vi.doUnmock('@core/config/settings/runtime-settings.js');
    vi.resetModules();
  });

  it('defaults memory dreaming off when settings are absent', async () => {
    const state = await loadMemoryState({});

    expect(state.RUNTIME_MEMORY_ENABLED).toBe(true);
    expect(state.RUNTIME_MEMORY_DREAMING_ENABLED).toBe(false);
  });

  it('keeps memory dreaming off when memory settings omit dreaming.enabled', async () => {
    const state = await loadMemoryState({ enabled: true });

    expect(state.RUNTIME_MEMORY_DREAMING_ENABLED).toBe(false);
  });

  it('enables memory dreaming only from explicit runtime settings', async () => {
    const state = await loadMemoryState({ dreamingEnabled: true });

    expect(state.RUNTIME_MEMORY_DREAMING_ENABLED).toBe(true);
  });
});
