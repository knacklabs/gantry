import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFileSync = vi.fn();
const mockPlatform = vi.fn();

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('os', () => ({
  default: {
    platform: (...args: unknown[]) => mockPlatform(...args),
  },
}));

describe('cli/platform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReturnValue('');
    mockPlatform.mockReturnValue('linux');
  });

  it('detectPlatform maps win32 to windows', async () => {
    mockPlatform.mockReturnValue('win32');
    const mod = await import('@core/cli/platform.js');
    expect(mod.detectPlatform()).toBe('windows');
  });

  it('commandExists uses where on windows', async () => {
    mockPlatform.mockReturnValue('win32');
    const mod = await import('@core/cli/platform.js');
    expect(mod.commandExists('node')).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith('where', ['node'], {
      stdio: 'ignore',
    });
  });

  it('commandExists uses which on non-windows hosts', async () => {
    mockPlatform.mockReturnValue('linux');
    const mod = await import('@core/cli/platform.js');
    expect(mod.commandExists('node')).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith('which', ['node'], {
      stdio: 'ignore',
    });
  });

  it('commandExists returns false when command lookup fails', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    const mod = await import('@core/cli/platform.js');
    expect(mod.commandExists('missing-bin')).toBe(false);
  });
});
