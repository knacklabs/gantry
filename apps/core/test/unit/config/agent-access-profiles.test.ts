import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_ACCESS_PRESET,
  isLockedDeniedIpcTaskType,
  resolveAgentAccessPolicy,
} from '@core/config/profiles.js';
import { ADMIN_MCP_TOOL_NAMES } from '@core/shared/admin-mcp-tools.js';
import { AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES } from '@core/runner/gantry-mcp-tool-surface.js';

describe('agent access policy resolution', () => {
  it('defaults to the full preset', () => {
    expect(DEFAULT_AGENT_ACCESS_PRESET).toBe('full');
    const policy = resolveAgentAccessPolicy(undefined);
    expect(policy.preset).toBe('full');
    expect(policy.permissionMode).toBe('default');
    expect(policy.mountedToolFamilies).toEqual({
      authorityTools: true,
      adminTools: true,
    });
    expect(policy.installMode).toBe('live');
  });

  it('resolves the full preset to today behavior', () => {
    const policy = resolveAgentAccessPolicy('full');
    expect(policy.preset).toBe('full');
    expect(policy.permissionMode).toBe('default');
    expect(policy.mountedToolFamilies.authorityTools).toBe(true);
    expect(policy.mountedToolFamilies.adminTools).toBe(true);
  });

  it('resolves the locked preset to zero authority/admin access', () => {
    const policy = resolveAgentAccessPolicy('locked');
    expect(policy.preset).toBe('locked');
    expect(policy.permissionMode).toBe('deny');
    expect(policy.mountedToolFamilies).toEqual({
      authorityTools: false,
      adminTools: false,
    });
    expect(policy.installMode).toBe('preprovisioned');
  });

  it('denies every authority-changing and admin IPC task type for locked agents', () => {
    for (const toolName of AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES) {
      const ipcType =
        toolName === 'request_access' ? 'request_permission' : toolName;
      expect(isLockedDeniedIpcTaskType(ipcType)).toBe(true);
    }
    for (const toolName of ADMIN_MCP_TOOL_NAMES) {
      expect(isLockedDeniedIpcTaskType(toolName)).toBe(true);
    }
  });

  it('does not deny non-authority IPC task types', () => {
    expect(isLockedDeniedIpcTaskType('send_message')).toBe(false);
    expect(isLockedDeniedIpcTaskType('agent_profile_read')).toBe(false);
    expect(isLockedDeniedIpcTaskType('mcp_list_tools')).toBe(false);
    expect(isLockedDeniedIpcTaskType('scheduler_upsert_job')).toBe(false);
  });
});
