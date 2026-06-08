import { describe, expect, it, vi } from 'vitest';

import { ensureRequiredMcpServerReady } from '@core/adapters/llm/anthropic-claude-agent/runner/mcp-server-validation.js';

// Regression guard for the SDK 0.3.156 upgrade (was 0.3.148): the Claude Agent
// SDK now emits `system/init` BEFORE the stdio `gantry` MCP server finishes its
// async connect, so the init snapshot reports `status: 'pending'`. The readiness
// gate must wait for the live `connected` state (via the SDK's mcpServerStatus()
// poll API) instead of throwing on the first pending snapshot — otherwise every
// agent reply fails with "Required Gantry MCP server is not ready: pending".

const noopSleep = async () => {};

function initMessage(
  mcpServers?: Array<{ name?: unknown; status?: unknown; error?: unknown }>,
): unknown {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 's',
    ...(mcpServers === undefined ? {} : { mcp_servers: mcpServers }),
  };
}

describe('ensureRequiredMcpServerReady', () => {
  it('resolves without polling when the init snapshot already shows gantry connected', async () => {
    const getLiveStatuses = vi.fn();
    await expect(
      ensureRequiredMcpServerReady(
        initMessage([{ name: 'gantry', status: 'connected' }]),
        { getLiveStatuses, sleep: noopSleep },
      ),
    ).resolves.toBeUndefined();
    expect(getLiveStatuses).not.toHaveBeenCalled();
  });

  it('polls live status when init is pending and resolves once gantry connects', async () => {
    const getLiveStatuses = vi
      .fn()
      .mockResolvedValueOnce([{ name: 'gantry', status: 'pending' }])
      .mockResolvedValueOnce([{ name: 'gantry', status: 'connected' }]);
    await expect(
      ensureRequiredMcpServerReady(
        initMessage([{ name: 'gantry', status: 'pending' }]),
        {
          getLiveStatuses,
          sleep: noopSleep,
          pollIntervalMs: 1,
          maxPollAttempts: 10,
        },
      ),
    ).resolves.toBeUndefined();
    expect(getLiveStatuses).toHaveBeenCalledTimes(2);
  });

  it('throws with the failure status and error detail when gantry failed', async () => {
    await expect(
      ensureRequiredMcpServerReady(
        initMessage([
          { name: 'gantry', status: 'failed', error: 'spawn ENOENT' },
        ]),
        { sleep: noopSleep },
      ),
    ).rejects.toThrow(/not ready: failed \(spawn ENOENT\)/);
  });

  it('throws "missing" when no gantry server is present in the snapshot', async () => {
    await expect(
      ensureRequiredMcpServerReady(
        initMessage([{ name: 'other', status: 'connected' }]),
        { sleep: noopSleep },
      ),
    ).rejects.toThrow(/Required Gantry MCP server is missing from Claude init/);
  });

  it('throws "status is missing" when the mcp_servers metadata is absent', async () => {
    await expect(
      ensureRequiredMcpServerReady(initMessage(undefined), {
        sleep: noopSleep,
      }),
    ).rejects.toThrow(
      /Required Gantry MCP server status is missing from Claude init/,
    );
  });

  it('gives up with a pending error after exhausting poll attempts', async () => {
    const getLiveStatuses = vi
      .fn()
      .mockResolvedValue([{ name: 'gantry', status: 'pending' }]);
    await expect(
      ensureRequiredMcpServerReady(
        initMessage([{ name: 'gantry', status: 'pending' }]),
        {
          getLiveStatuses,
          sleep: noopSleep,
          pollIntervalMs: 1,
          maxPollAttempts: 3,
        },
      ),
    ).rejects.toThrow(/not ready: pending/);
    expect(getLiveStatuses).toHaveBeenCalledTimes(3);
  });

  it('throws immediately on pending when no live-status poller is available', async () => {
    await expect(
      ensureRequiredMcpServerReady(
        initMessage([{ name: 'gantry', status: 'pending' }]),
        { sleep: noopSleep },
      ),
    ).rejects.toThrow(/not ready: pending/);
  });
});
