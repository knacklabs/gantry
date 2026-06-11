import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempRoots: string[] = [];
const STUBBED_ENV_KEYS = [
  'GANTRY_IPC_DIR',
  'GANTRY_AGENT_ACCESS_PRESET',
  'GANTRY_DEPLOYMENT_MODE',
  'GANTRY_ADMIN_MCP_TOOLS_JSON',
  'GANTRY_MCP_TOOL_NAMES_JSON',
  'GANTRY_SELECTED_SKILLS_JSON',
  'GANTRY_SELECTED_MCP_SERVERS_JSON',
  'GANTRY_CHAT_JID',
] as const;
const previousEnv = new Map<string, string | undefined>(
  STUBBED_ENV_KEYS.map((key) => [key, process.env[key]]),
);

function setRunnerEnv(env: Record<string, string | undefined>): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-locked-intro-'));
  tempRoots.push(root);
  process.env.GANTRY_IPC_DIR = root;
  process.env.GANTRY_CHAT_JID = 'tg:support';
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  vi.resetModules();
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('capabilityStatusText access projection', () => {
  it('locked agents get a provisioned-only view with no requestable machinery', async () => {
    setRunnerEnv({
      GANTRY_AGENT_ACCESS_PRESET: 'locked',
      // Stale/forged selections and an unset tool-name env must not surface
      // requestable machinery: locked parsing fails closed.
      GANTRY_ADMIN_MCP_TOOLS_JSON: JSON.stringify(['service_restart']),
      GANTRY_MCP_TOOL_NAMES_JSON: undefined,
      GANTRY_SELECTED_SKILLS_JSON: JSON.stringify(['skill:refunds']),
      GANTRY_SELECTED_MCP_SERVERS_JSON: JSON.stringify(['mcp:crm']),
    });
    vi.resetModules();
    const { capabilityStatusText } =
      await import('@core/runner/mcp/context.js');

    const text = capabilityStatusText();
    expect(text).not.toContain('requestable');
    expect(text).not.toContain('request_access');
    expect(text).not.toContain('Agent access model');
    expect(text).not.toContain('Gantry admin tool capabilities');
    expect(text).not.toContain('admin_permission_list');
    expect(text).not.toContain('service_restart');
    expect(text).not.toContain('Tool Access:');
    // Browser is not provisioned, so the section is omitted entirely.
    expect(text).not.toContain('Browser capability:');

    // Scheduler tools are not mounted for locked agents, so their guidance
    // block must not appear either.
    expect(text).not.toContain('Scheduler monitoring');
    expect(text).not.toContain('scheduler_');

    // Provisioned view stays intact.
    expect(text).toContain('- available: mcp__gantry__send_message');
    expect(text).toContain('- ready: skill:refunds');
    expect(text).toContain('- ready: mcp:crm');
  });

  it('full agents keep the requestable access model and Tool Access view', async () => {
    setRunnerEnv({
      GANTRY_AGENT_ACCESS_PRESET: 'full',
      GANTRY_ADMIN_MCP_TOOLS_JSON: JSON.stringify(['service_restart']),
      GANTRY_MCP_TOOL_NAMES_JSON: undefined,
      GANTRY_SELECTED_SKILLS_JSON: JSON.stringify([]),
      GANTRY_SELECTED_MCP_SERVERS_JSON: JSON.stringify([]),
    });
    vi.resetModules();
    const { capabilityStatusText } =
      await import('@core/runner/mcp/context.js');

    const text = capabilityStatusText();
    expect(text).toContain('Agent access model:');
    expect(text).toContain('request_access target.kind=capability');
    expect(text).toContain('Gantry admin tool capabilities:');
    expect(text).toContain('- requestable: mcp__gantry__register_agent');
    expect(text).toContain('- available: mcp__gantry__service_restart');
    expect(text).toContain('Tool Access:');
    expect(text).toContain('Scheduler monitoring:');
  });
});

describe('locked MCP listing and tool descriptions', () => {
  const listToolsData = {
    servers: [
      {
        name: 'crm',
        tools: [{ name: 'lookup_order', description: 'Find an order' }],
      },
    ],
  };

  it('formatMcpListToolsResponse omits review guidance when asked', async () => {
    setRunnerEnv({ GANTRY_AGENT_ACCESS_PRESET: 'locked' });
    vi.resetModules();
    const { formatMcpListToolsResponse } =
      await import('@core/runner/mcp/tools/service-formatters.js');

    const provisionedOnly = formatMcpListToolsResponse(listToolsData, {
      includeReviewGuidance: false,
    });
    expect(provisionedOnly).toContain(
      'Tools available from connected MCP servers:',
    );
    expect(provisionedOnly).toContain('- lookup_order - Find an order');
    expect(provisionedOnly).not.toContain('reviewed action capability');
    expect(provisionedOnly).not.toContain('inventory');

    const full = formatMcpListToolsResponse(listToolsData);
    expect(full).toContain('MCP source inventory:');
    expect(full).toContain('reviewed action capability');
  });

  it('registers neutral mcp tool descriptions for locked agents', async () => {
    setRunnerEnv({ GANTRY_AGENT_ACCESS_PRESET: 'locked' });
    vi.resetModules();
    const { registerServiceTools } =
      await import('@core/runner/mcp/tools/service.js');
    const registrations: Array<[string, string]> = [];
    const fakeServer = {
      tool: (name: string, description: string) => {
        registrations.push([name, description]);
      },
    };

    registerServiceTools(fakeServer as never);

    const listToolsDescription = registrations.find(
      ([name]) => name === 'mcp_list_tools',
    )?.[1];
    const callToolDescription = registrations.find(
      ([name]) => name === 'mcp_call_tool',
    )?.[1];
    expect(listToolsDescription).toBe(
      'List tools from MCP server sources connected to this agent.',
    );
    expect(callToolDescription).not.toContain('reviewed');
  });

  it('keeps the full mcp tool descriptions unchanged', async () => {
    setRunnerEnv({ GANTRY_AGENT_ACCESS_PRESET: 'full' });
    vi.resetModules();
    const { registerServiceTools } =
      await import('@core/runner/mcp/tools/service.js');
    const registrations: Array<[string, string]> = [];
    const fakeServer = {
      tool: (name: string, description: string) => {
        registrations.push([name, description]);
      },
    };

    registerServiceTools(fakeServer as never);

    expect(registrations.find(([name]) => name === 'mcp_list_tools')?.[1]).toBe(
      'Refresh tools from MCP server sources connected to this agent. This is source inventory only; use reviewed action capabilities as the authority.',
    );
  });
});

describe('deployment-mode aware install guidance', () => {
  const installedSkillContext = {
    type: 'installed_skill_context',
    skill: { id: 'skill:refunds', name: 'refunds' },
    requiredEnvVars: [],
    files: [{ path: 'SKILL.md', content: '# refunds' }],
  };

  it('workstation keeps the immediate-load text', async () => {
    setRunnerEnv({ GANTRY_DEPLOYMENT_MODE: 'workstation' });
    vi.resetModules();
    const { formatSkillProposalResponse } =
      await import('@core/runner/mcp/tools/service-formatters.js');

    const text = formatSkillProposalResponse(installedSkillContext, 'Done.');
    expect(text).toContain(
      'Gantry will load the skill automatically for later runs.',
    );
    expect(text).not.toContain('propagates to eligible workers');
  });

  it('fleet adds the worker propagation clause', async () => {
    setRunnerEnv({ GANTRY_DEPLOYMENT_MODE: 'fleet' });
    vi.resetModules();
    const { formatSkillProposalResponse } =
      await import('@core/runner/mcp/tools/service-formatters.js');

    const text = formatSkillProposalResponse(installedSkillContext, 'Done.', {
      deploymentMode: 'fleet',
    });
    expect(text).toContain(
      'Gantry will load the skill automatically for later runs after it propagates to eligible workers.',
    );
  });

  it('fleet switches the dependency-install description to bake timing', async () => {
    setRunnerEnv({ GANTRY_DEPLOYMENT_MODE: 'fleet' });
    vi.resetModules();
    const { registerServiceTools } =
      await import('@core/runner/mcp/tools/service.js');
    const registrations: Array<[string, string]> = [];
    const fakeServer = {
      tool: (name: string, description: string) => {
        registrations.push([name, description]);
      },
    };

    registerServiceTools(fakeServer as never);

    const description = registrations.find(
      ([name]) => name === 'request_skill_dependency_install',
    )?.[1];
    expect(description).toContain('baked into a worker toolchain');
    expect(description).toContain('take minutes');
    expect(description).not.toContain('host-installed');
  });

  it('workstation keeps the host-install dependency description', async () => {
    setRunnerEnv({ GANTRY_DEPLOYMENT_MODE: 'workstation' });
    vi.resetModules();
    const { registerServiceTools } =
      await import('@core/runner/mcp/tools/service.js');
    const registrations: Array<[string, string]> = [];
    const fakeServer = {
      tool: (name: string, description: string) => {
        registrations.push([name, description]);
      },
    };

    registerServiceTools(fakeServer as never);

    expect(
      registrations.find(
        ([name]) => name === 'request_skill_dependency_install',
      )?.[1],
    ).toBe(
      'Request host-installed dependencies needed by a reviewed skill source. Approval records setup inventory; the agent never runs install commands directly.',
    );
  });
});
