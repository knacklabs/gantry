import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const previousIpcDir = process.env.GANTRY_IPC_DIR;
const previousAdminTools = process.env.GANTRY_ADMIN_MCP_TOOLS_JSON;
const previousMcpTools = process.env.GANTRY_MCP_TOOL_NAMES_JSON;
const previousNoPermissionTools = process.env.GANTRY_NO_PERMISSION_TOOLS;
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
  if (previousNoPermissionTools === undefined) {
    delete process.env.GANTRY_NO_PERMISSION_TOOLS;
  } else {
    process.env.GANTRY_NO_PERMISSION_TOOLS = previousNoPermissionTools;
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

describe('effective enabled MCP tool projection', () => {
  it('preserves selected admin tools in normal mode', async () => {
    setIpcDir();
    const { effectiveEnabledMcpToolNames } =
      await import('@core/runner/mcp/server.js');

    const enabled = effectiveEnabledMcpToolNames(
      undefined,
      JSON.stringify(['service_restart']),
      undefined,
    );

    expect(enabled.has('service_restart')).toBe(true);
  });

  it('strips hidden authority tools while preserving selected admin tools', async () => {
    setIpcDir();
    const { effectiveEnabledMcpToolNames } =
      await import('@core/runner/mcp/server.js');

    const enabled = effectiveEnabledMcpToolNames(
      undefined,
      JSON.stringify(['service_restart', 'register_agent']),
      '1',
    );

    // Selected admin tools are registered through the admin facade list.
    expect(enabled.has('service_restart')).toBe(true);
    expect(enabled.has('register_agent')).toBe(true);
    expect(enabled.has('request_settings_update')).toBe(false);
    // Authority-changing baseline request tools stripped.
    expect(enabled.has('request_access')).toBe(false);
    expect(enabled.has('request_skill_install')).toBe(false);
    expect(enabled.has('request_mcp_server')).toBe(false);
    expect(enabled.has('request_agent_profile_update')).toBe(false);
    // Scheduler mutation/control tools are not part of the no-permission
    // user-facing surface.
    expect(enabled.has('scheduler_upsert_job')).toBe(false);
    expect(enabled.has('scheduler_update_job')).toBe(false);
    expect(enabled.has('scheduler_run_now')).toBe(false);
    // Safe baseline preserved.
    expect(enabled.has('send_message')).toBe(true);
    expect(enabled.has('ask_user_question')).toBe(true);
    expect(enabled.has('async_run_command')).toBe(false);
    expect(enabled.has('task_get')).toBe(false);
    expect(enabled.has('task_list')).toBe(false);
    expect(enabled.has('task_cancel')).toBe(false);
    expect(enabled.has('todo_update')).toBe(true);
    expect(enabled.has('delegate_task')).toBe(false);
    expect(enabled.has('task_message')).toBe(false);
    expect(enabled.has('memory_search')).toBe(true);
    expect(enabled.has('agent_profile_read')).toBe(true);
  });

  it('mounts async task controls only when the host enables the executor', async () => {
    setIpcDir();
    const { effectiveEnabledMcpToolNames } =
      await import('@core/runner/mcp/server.js');

    const enabled = effectiveEnabledMcpToolNames(
      JSON.stringify([
        'async_run_command',
        'task_get',
        'task_list',
        'task_cancel',
        'delegate_task',
        'task_message',
      ]),
      undefined,
      undefined,
      false,
      '1',
    );

    expect(enabled.has('async_run_command')).toBe(true);
    expect(enabled.has('task_get')).toBe(true);
    expect(enabled.has('task_list')).toBe(true);
    expect(enabled.has('task_cancel')).toBe(true);
    expect(enabled.has('delegate_task')).toBe(true);
    expect(enabled.has('task_message')).toBe(true);
  });
});
