import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

describe('ipc-mcp-stdio fast lookup gating', () => {
  beforeEach(() => {
    vi.resetModules();
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('does not register fast lookup when disabled by env', async () => {
    process.env.MYCLAW_FAST_LOOKUP_ENABLED = '0';

    const mod = await import('./ipc-mcp-stdio.js');
    const tool = vi.fn();

    expect(mod.isFastLookupEnabled()).toBe(false);
    expect(
      mod.registerFastLookupTool(
        { tool } as unknown as { tool: typeof tool },
        { MYCLAW_FAST_LOOKUP_ENABLED: '0' } as NodeJS.ProcessEnv,
      ),
    ).toBe(false);
    expect(tool).not.toHaveBeenCalled();
  });

  it('registers fast lookup when enabled by env', async () => {
    process.env.MYCLAW_FAST_LOOKUP_ENABLED = '1';

    const mod = await import('./ipc-mcp-stdio.js');
    const tool = vi.fn();

    expect(mod.isFastLookupEnabled()).toBe(true);
    expect(
      mod.registerFastLookupTool(
        { tool } as unknown as { tool: typeof tool },
        { MYCLAW_FAST_LOOKUP_ENABLED: '1' } as NodeJS.ProcessEnv,
      ),
    ).toBe(true);
    expect(tool).toHaveBeenCalledOnce();
    expect(tool.mock.calls[0]?.[0]).toBe('fast_lookup');
  });
});
