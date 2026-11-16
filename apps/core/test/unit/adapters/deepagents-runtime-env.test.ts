import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveWorkspaceIpcDir } from '@core/adapters/llm/deepagents-langchain/runner/runtime-env.js';

afterEach(() => vi.unstubAllEnvs());

describe('DeepAgents runner IPC path', () => {
  it('uses the host-projected workspace directory without repeating the folder', () => {
    vi.stubEnv('GANTRY_IPC_DIR', '/data/gantry/data/ipc/agent-one');
    expect(resolveWorkspaceIpcDir('agent-one')).toBe(
      '/data/gantry/data/ipc/agent-one',
    );
  });

  it('supports an unscoped IPC root', () => {
    vi.stubEnv('GANTRY_IPC_DIR', '/data/gantry/data/ipc');
    expect(resolveWorkspaceIpcDir('agent-one')).toBe(
      '/data/gantry/data/ipc/agent-one',
    );
  });

  it('requires the host-projected IPC directory', () => {
    vi.stubEnv('GANTRY_IPC_DIR', '');
    expect(() => resolveWorkspaceIpcDir('agent-one')).toThrow('GANTRY_IPC_DIR');
  });
});
