import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
  DEFAULT_GANTRY_MCP_TOOL_NAMES,
  parseEnabledGantryMcpToolNames,
  selectedGantryMcpToolNames,
} from '@core/runner/gantry-mcp-tool-surface.js';
import { ADMIN_MCP_TOOL_NAMES } from '@core/shared/admin-mcp-tools.js';

// server.js transitively requires GANTRY_IPC_DIR at import time, so the env
// must be set before the dynamic import resolves.
let effectiveEnabledMcpToolNames: (typeof import('@core/runner/mcp/server.js'))['effectiveEnabledMcpToolNames'];
let ipcRoot: string;
const previousIpcDir = process.env.GANTRY_IPC_DIR;

beforeAll(async () => {
  ipcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-locked-surface-'));
  process.env.GANTRY_IPC_DIR = ipcRoot;
  ({ effectiveEnabledMcpToolNames } =
    await import('@core/runner/mcp/server.js'));
});

afterAll(() => {
  if (previousIpcDir === undefined) delete process.env.GANTRY_IPC_DIR;
  else process.env.GANTRY_IPC_DIR = previousIpcDir;
  fs.rmSync(ipcRoot, { recursive: true, force: true });
});

function hasAnyAuthorityOrAdminTool(names: Iterable<string>): boolean {
  const set = new Set(names);
  return (
    AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES.some((toolName) =>
      set.has(toolName),
    ) || ADMIN_MCP_TOOL_NAMES.some((toolName) => set.has(toolName))
  );
}

describe('locked tool surface mounting', () => {
  it('full preset keeps the default surface unchanged', () => {
    const names = effectiveEnabledMcpToolNames(
      JSON.stringify([...DEFAULT_GANTRY_MCP_TOOL_NAMES]),
      undefined,
      undefined,
      false,
    );
    for (const toolName of DEFAULT_GANTRY_MCP_TOOL_NAMES) {
      expect(names.has(toolName)).toBe(true);
    }
  });

  it('locked preset excludes every authority and admin tool', () => {
    const names = effectiveEnabledMcpToolNames(
      JSON.stringify([
        ...DEFAULT_GANTRY_MCP_TOOL_NAMES,
        ...AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
      ]),
      JSON.stringify([...ADMIN_MCP_TOOL_NAMES]),
      undefined,
      true,
    );
    expect(hasAnyAuthorityOrAdminTool(names)).toBe(false);
    // pre-provisioned baseline tools still mount.
    expect(names.has('send_message')).toBe(true);
    expect(names.has('mcp_list_tools')).toBe(true);
    expect(names.has('mcp_describe_tool')).toBe(true);
  });

  it('locked preset never re-adds selected admin tools', () => {
    const names = effectiveEnabledMcpToolNames(
      JSON.stringify([...DEFAULT_GANTRY_MCP_TOOL_NAMES]),
      JSON.stringify([...ADMIN_MCP_TOOL_NAMES]),
      '1',
      true,
    );
    for (const toolName of ADMIN_MCP_TOOL_NAMES) {
      expect(names.has(toolName)).toBe(false);
    }
  });

  it('non-locked no-permission mode still re-adds selected admin tools', () => {
    const names = effectiveEnabledMcpToolNames(
      JSON.stringify([...DEFAULT_GANTRY_MCP_TOOL_NAMES]),
      JSON.stringify(['service_restart']),
      '1',
      false,
    );
    expect(names.has('service_restart')).toBe(true);
  });

  it('selectedGantryMcpToolNames excludes authority tools for locked agents', () => {
    const names = selectedGantryMcpToolNames([], {
      excludeAuthorityTools: true,
    });
    expect(hasAnyAuthorityOrAdminTool(names)).toBe(false);
  });

  it('withholds async task controls unless the executor is enabled', () => {
    const defaultNames = selectedGantryMcpToolNames([]);
    expect(defaultNames).toContain('todo_update');
    expect(defaultNames).not.toContain('async_run_command');
    expect(defaultNames).not.toContain('task_get');
    expect(defaultNames).not.toContain('task_list');
    expect(defaultNames).not.toContain('task_cancel');
    expect(defaultNames).not.toContain('delegate_task');
    expect(defaultNames).not.toContain('task_message');

    const enabledNames = selectedGantryMcpToolNames([], {
      asyncTaskToolsEnabled: true,
    });
    expect(enabledNames).toContain('async_run_command');
    expect(enabledNames).toContain('task_get');
    expect(enabledNames).toContain('task_list');
    expect(enabledNames).toContain('task_cancel');
    expect(enabledNames).not.toContain('delegate_task');
    expect(enabledNames).not.toContain('task_message');

    const delegatedNames = selectedGantryMcpToolNames(['AgentDelegation'], {
      asyncTaskToolsEnabled: true,
    });
    expect(delegatedNames).toContain('delegate_task');
    expect(delegatedNames).toContain('task_message');

    const explicitlyConfiguredNames = selectedGantryMcpToolNames([
      'mcp__gantry__delegate_task',
      'mcp__gantry__task_get',
      'mcp__gantry__task_cancel',
      'mcp__gantry__task_message',
    ]);
    expect(explicitlyConfiguredNames).not.toContain('delegate_task');
    expect(explicitlyConfiguredNames).not.toContain('task_get');
    expect(explicitlyConfiguredNames).not.toContain('task_cancel');
    expect(explicitlyConfiguredNames).not.toContain('task_message');

    const parsedNames = parseEnabledGantryMcpToolNames(
      JSON.stringify([
        'delegate_task',
        'task_get',
        'task_cancel',
        'task_message',
      ]),
    );
    expect(parsedNames.has('delegate_task')).toBe(true);
    expect(parsedNames.has('task_get')).toBe(true);
    expect(parsedNames.has('task_cancel')).toBe(true);
    expect(parsedNames.has('task_message')).toBe(true);

    const lockedNames = selectedGantryMcpToolNames(['AgentDelegation'], {
      excludeAuthorityTools: true,
    });
    expect(lockedNames).toContain('todo_update');
    expect(lockedNames).not.toContain('async_run_command');
    expect(lockedNames).not.toContain('task_get');
    expect(lockedNames).not.toContain('task_list');
    expect(lockedNames).not.toContain('task_cancel');
    expect(lockedNames).not.toContain('delegate_task');
    expect(lockedNames).not.toContain('task_message');
  });
});

describe('locked fail-closed env parsing', () => {
  it('returns the locked base set for an unset env', () => {
    const names = parseEnabledGantryMcpToolNames(undefined, {
      lockedPreset: true,
    });
    expect(hasAnyAuthorityOrAdminTool(names)).toBe(false);
    expect(names.has('send_message')).toBe(true);
  });

  it('returns the locked base set for garbage JSON', () => {
    const names = parseEnabledGantryMcpToolNames('{not json', {
      lockedPreset: true,
    });
    expect(hasAnyAuthorityOrAdminTool(names)).toBe(false);
  });

  it('returns the locked base set for a non-array JSON value', () => {
    const names = parseEnabledGantryMcpToolNames('{"a":1}', {
      lockedPreset: true,
    });
    expect(hasAnyAuthorityOrAdminTool(names)).toBe(false);
  });

  it('drops authority tools even when present in a valid env array', () => {
    const names = parseEnabledGantryMcpToolNames(
      JSON.stringify([
        'send_message',
        ...AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
        ...ADMIN_MCP_TOOL_NAMES,
      ]),
      { lockedPreset: true },
    );
    expect(names.has('send_message')).toBe(true);
    expect(hasAnyAuthorityOrAdminTool(names)).toBe(false);
  });

  it('full preset still fails open to the default set on corrupt env', () => {
    const names = parseEnabledGantryMcpToolNames('{not json');
    for (const toolName of DEFAULT_GANTRY_MCP_TOOL_NAMES) {
      expect(names.has(toolName)).toBe(true);
    }
  });
});
