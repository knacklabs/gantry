import { describe, expect, it, vi } from 'vitest';

async function loadFactoryWithUnopenedStorage() {
  vi.resetModules();
  const createGroupProcessor = vi.fn(() => ({}));
  const getRuntimeStorage = vi.fn(() => {
    throw new Error('Runtime storage has not been initialized');
  });
  vi.doMock('@core/runtime/group-processing.js', () => ({
    createGroupProcessor,
  }));
  vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
    getRuntimeStorage,
    getRuntimeRepositories: vi.fn(),
    getRuntimeSkillArtifactStore: vi.fn(),
    getConfiguredModelProvidersForApp: vi.fn(async () => new Set<string>()),
    resolveRuntimePersonIdentity: vi.fn(),
  }));
  const mod = await import('@core/app/bootstrap/group-processor-deps.js');
  return { mod, createGroupProcessor, getRuntimeStorage };
}

describe('createRuntimeGroupProcessor', () => {
  it('builds the processor before runtime storage is opened and resolves storage on first use', async () => {
    const { mod, createGroupProcessor, getRuntimeStorage } =
      await loadFactoryWithUnopenedStorage();

    expect(() => mod.createRuntimeGroupProcessor({} as never)).not.toThrow();
    expect(getRuntimeStorage).not.toHaveBeenCalled();

    const deps = createGroupProcessor.mock.calls[0]?.[0] as {
      getToolRepository: () => unknown;
      remembered: { service: unknown };
    };
    expect(() => deps.getToolRepository()).toThrow(
      'Runtime storage has not been initialized',
    );
    expect(() => deps.remembered.service).toThrow(
      'Runtime storage has not been initialized',
    );
  });
});
