import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const previousIpcDir = process.env.GANTRY_IPC_DIR;
const previousAdminTools = process.env.GANTRY_ADMIN_MCP_TOOLS_JSON;
const previousMcpTools = process.env.GANTRY_MCP_TOOL_NAMES_JSON;
const tempRoots: string[] = [];

afterEach(() => {
  vi.resetModules();
  if (previousIpcDir === undefined) {
    delete process.env.GANTRY_IPC_DIR;
  } else {
    process.env.GANTRY_IPC_DIR = previousIpcDir;
  }
  if (previousAdminTools === undefined) {
    delete process.env.GANTRY_ADMIN_MCP_TOOLS_JSON;
  } else {
    process.env.GANTRY_ADMIN_MCP_TOOLS_JSON = previousAdminTools;
  }
  if (previousMcpTools === undefined) {
    delete process.env.GANTRY_MCP_TOOL_NAMES_JSON;
  } else {
    process.env.GANTRY_MCP_TOOL_NAMES_JSON = previousMcpTools;
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function setIpcDir(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-mcp-parity-'));
  tempRoots.push(root);
  process.env.GANTRY_IPC_DIR = root;
}

describe('MCP server registry handler parity', () => {
  it('fails boot when an enabled MCP tool has no registered handler', async () => {
    setIpcDir();
    const { assertRegisteredMcpToolHandlers } =
      await import('@core/runner/mcp/server.js');

    expect(() =>
      assertRegisteredMcpToolHandlers({
        enabledTools: new Set([
          'browser',
          'scheduler_list_models',
          'scheduler_list_notification_targets',
        ]),
        registeredHandlers: new Set(['scheduler_list_models']),
      }),
    ).toThrow(
      [
        'Gantry could not start because browser is registered without a handler.',
        'cause: MCP tool registry mismatch',
        'recover: remove the tool registration or add its handler before starting Gantry.',
      ].join('\n'),
    );
  });

  it('allows boot when every enabled MCP tool has a handler', async () => {
    setIpcDir();
    const { assertRegisteredMcpToolHandlers } =
      await import('@core/runner/mcp/server.js');

    expect(() =>
      assertRegisteredMcpToolHandlers({
        enabledTools: new Set(['scheduler_list_notification_targets']),
        registeredHandlers: new Set(['scheduler_list_notification_targets']),
      }),
    ).not.toThrow();
  });

  it('checks handler parity before returning the MCP server', async () => {
    setIpcDir();
    process.env.GANTRY_ADMIN_MCP_TOOLS_JSON = JSON.stringify([
      'service_restart',
    ]);
    const { createGantryMcpServer } =
      await import('@core/runner/mcp/server.js');

    expect(() => createGantryMcpServer()).not.toThrow();
  });
});
