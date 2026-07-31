import { describe, expect, it } from 'vitest';

import {
  assertHostAccessSnapshot,
  type AgentAccessSnapshot,
} from '@core/application/agent-execution/agent-access-snapshot.js';

describe('assertHostAccessSnapshot', () => {
  it('accepts a snapshot whose authority rows match the host owner', () => {
    const snapshot = snapshotForHost();

    expect(
      assertHostAccessSnapshot({
        accessSnapshot: snapshot,
        appId: 'app:test',
        agentId: 'agent:test',
        subject: 'Test projection',
      }),
    ).toBe(snapshot);
  });

  it('permits nullable and lifecycle-inactive active-binding definitions', () => {
    const snapshot = snapshotForHost();
    snapshot.tools.activeBindings[0]!.definition = {
      ...toolDefinition(),
      status: 'disabled',
    };
    snapshot.skills.activeBindings[0]!.definition = {
      ...skillDefinition(),
      status: 'disabled',
    };
    snapshot.mcp.activeBindings[0]!.definition = {
      ...mcpDefinition(),
      status: 'disabled',
    };
    snapshot.tools.activeBindings = [
      ...snapshot.tools.activeBindings,
      {
        ...snapshot.tools.activeBindings[0]!,
        definition: null,
      },
    ];
    snapshot.skills.activeBindings = [
      ...snapshot.skills.activeBindings,
      {
        ...snapshot.skills.activeBindings[0]!,
        definition: null,
      },
    ];
    snapshot.mcp.activeBindings = [
      ...snapshot.mcp.activeBindings,
      {
        ...snapshot.mcp.activeBindings[0]!,
        definition: null,
      },
    ];

    expect(() =>
      assertHostAccessSnapshot({
        accessSnapshot: snapshot,
        appId: 'app:test',
        agentId: 'agent:test',
        subject: 'Test projection',
      }),
    ).not.toThrow();
  });

  it.each([
    {
      label: 'snapshot owner',
      mutate: (snapshot: AgentAccessSnapshot) => {
        snapshot.agentId = 'agent:other';
      },
      message: 'Test projection access snapshot owner mismatch.',
    },
    {
      label: 'tool active binding owner',
      mutate: (snapshot: AgentAccessSnapshot) => {
        snapshot.tools.activeBindings[0]!.binding.agentId = 'agent:other';
      },
      message: 'Test projection tool snapshot row owner mismatch.',
    },
    {
      label: 'tool active binding status',
      mutate: (snapshot: AgentAccessSnapshot) => {
        snapshot.tools.activeBindings[0]!.binding.status = 'disabled';
      },
      message: 'Test projection tool snapshot row owner mismatch.',
    },
    {
      label: 'tool binding-definition id consistency',
      mutate: (snapshot: AgentAccessSnapshot) => {
        snapshot.tools.activeBindings[0]!.binding.toolId = 'tool:other';
      },
      message: 'Test projection tool snapshot row owner mismatch.',
    },
    {
      label: 'app-active tool definition owner',
      mutate: (snapshot: AgentAccessSnapshot) => {
        snapshot.tools.appActiveDefinitions[0]!.appId = 'app:other';
      },
      message: 'Test projection tool snapshot definition owner mismatch.',
    },
    {
      label: 'app-active tool definition status',
      mutate: (snapshot: AgentAccessSnapshot) => {
        snapshot.tools.appActiveDefinitions[0]!.status = 'disabled';
      },
      message: 'Test projection tool snapshot definition owner mismatch.',
    },
    {
      label: 'skill active binding owner',
      mutate: (snapshot: AgentAccessSnapshot) => {
        snapshot.skills.activeBindings[0]!.binding.appId = 'app:other';
      },
      message: 'Test projection skill snapshot row owner mismatch.',
    },
    {
      label: 'skill active binding status',
      mutate: (snapshot: AgentAccessSnapshot) => {
        snapshot.skills.activeBindings[0]!.binding.status = 'disabled';
      },
      message: 'Test projection skill snapshot row owner mismatch.',
    },
    {
      label: 'skill binding-definition id consistency',
      mutate: (snapshot: AgentAccessSnapshot) => {
        snapshot.skills.activeBindings[0]!.binding.skillId = 'skill:other';
      },
      message: 'Test projection skill snapshot row owner mismatch.',
    },
    {
      label: 'enabled skill definition owner',
      mutate: (snapshot: AgentAccessSnapshot) => {
        snapshot.skills.enabledDefinitions[0]!.agentId = 'agent:other';
      },
      message: 'Test projection skill snapshot definition owner mismatch.',
    },
    {
      label: 'enabled skill definition status',
      mutate: (snapshot: AgentAccessSnapshot) => {
        snapshot.skills.enabledDefinitions[0]!.status = 'disabled';
      },
      message: 'Test projection skill snapshot definition owner mismatch.',
    },
    {
      label: 'MCP active binding owner',
      mutate: (snapshot: AgentAccessSnapshot) => {
        snapshot.mcp.activeBindings[0]!.binding.agentId = 'agent:other';
      },
      message: 'Test projection MCP snapshot row owner mismatch.',
    },
    {
      label: 'MCP active binding status',
      mutate: (snapshot: AgentAccessSnapshot) => {
        snapshot.mcp.activeBindings[0]!.binding.status = 'disabled';
      },
      message: 'Test projection MCP snapshot row owner mismatch.',
    },
    {
      label: 'MCP binding-definition id consistency',
      mutate: (snapshot: AgentAccessSnapshot) => {
        snapshot.mcp.activeBindings[0]!.binding.serverId = 'mcp:other';
      },
      message: 'Test projection MCP snapshot row owner mismatch.',
    },
    {
      label: 'materialized MCP binding owner',
      mutate: (snapshot: AgentAccessSnapshot) => {
        snapshot.mcp.materializedServers[0]!.binding.appId = 'app:other';
      },
      message: 'Test projection MCP materialized snapshot row owner mismatch.',
    },
    {
      label: 'materialized MCP definition status',
      mutate: (snapshot: AgentAccessSnapshot) => {
        snapshot.mcp.materializedServers[0]!.definition.status = 'disabled';
      },
      message: 'Test projection MCP materialized snapshot row owner mismatch.',
    },
    {
      label: 'materialized MCP id consistency',
      mutate: (snapshot: AgentAccessSnapshot) => {
        snapshot.mcp.materializedServers[0]!.binding.serverId = 'mcp:other';
      },
      message: 'Test projection MCP materialized snapshot row owner mismatch.',
    },
  ])('fails closed for $label', ({ mutate, message }) => {
    const snapshot = snapshotForHost();
    mutate(snapshot);

    expect(() =>
      assertHostAccessSnapshot({
        accessSnapshot: snapshot,
        appId: 'app:test',
        agentId: 'agent:test',
        subject: 'Test projection',
      }),
    ).toThrow(message);
  });
});

function snapshotForHost(): AgentAccessSnapshot {
  return {
    appId: 'app:test',
    agentId: 'agent:test',
    tools: {
      activeBindings: [
        {
          binding: {
            id: 'tool-binding:one',
            appId: 'app:test',
            agentId: 'agent:test',
            toolId: 'tool:file-read',
            status: 'active',
            createdAt: '2026-07-28T00:00:00.000Z',
            updatedAt: '2026-07-28T00:00:00.000Z',
          },
          definition: toolDefinition(),
        },
      ],
      appActiveDefinitions: [toolDefinition()],
    },
    skills: {
      activeBindings: [
        {
          binding: {
            id: 'skill-binding:one',
            appId: 'app:test',
            agentId: 'agent:test',
            skillId: 'skill:release',
            status: 'active',
            createdAt: '2026-07-28T00:00:00.000Z',
            updatedAt: '2026-07-28T00:00:00.000Z',
          },
          definition: skillDefinition(),
        },
      ],
      enabledDefinitions: [skillDefinition()],
    },
    mcp: {
      activeBindings: [
        {
          binding: mcpBinding(),
          definition: mcpDefinition(),
        },
      ],
      materializedServers: [
        {
          binding: mcpBinding(),
          definition: mcpDefinition(),
        },
      ],
    },
  } as AgentAccessSnapshot;
}

function toolDefinition() {
  return {
    id: 'tool:file-read',
    appId: 'app:test',
    name: 'FileRead',
    kind: 'host',
    provider: 'gantry',
    displayName: 'File read',
    category: 'files',
    risk: 'low',
    selectable: true,
    status: 'active',
    adapterRef: 'core:file-read',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
}

function skillDefinition() {
  return {
    id: 'skill:release',
    appId: 'app:test',
    agentId: 'agent:test',
    name: 'release',
    source: 'admin_uploaded',
    status: 'installed',
    promptRefs: [],
    toolIds: [],
    workflowRefs: [],
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
}

function mcpBinding() {
  return {
    id: 'mcp-binding:one',
    appId: 'app:test',
    agentId: 'agent:test',
    serverId: 'mcp:github',
    status: 'active',
    required: false,
    permissionPolicyIds: [],
    allowedToolPatterns: [],
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
}

function mcpDefinition() {
  return {
    id: 'mcp:github',
    appId: 'app:test',
    name: 'github',
    status: 'active',
    transport: 'http',
    config: {
      transport: 'http',
      url: 'https://mcp.example.test/github',
    },
    allowedToolPatterns: [],
    autoApproveToolPatterns: [],
    credentialRefs: [],
    networkHosts: [],
    createdSource: 'admin',
    riskClass: 'medium',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
}
