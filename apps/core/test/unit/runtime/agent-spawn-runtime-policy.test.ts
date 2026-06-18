import { describe, expect, it } from 'vitest';

import {
  SANDBOX_RUNTIME_MODEL_GATEWAY_HOST,
  databaseNetworkHostFromUrl,
  loopbackAuthorityFromUrl,
  pickPreparedExecutionEnv,
  projectSandboxRuntimeModelGatewayEnv,
  resolveRunnerMcpProjection,
} from '@core/runtime/agent-spawn-runtime-policy.js';
import type { MaterializedMcpServer } from '@core/domain/mcp/mcp-servers.js';
import type { CapabilityRuntimeAccess } from '@core/shared/capability-runtime-access.js';
import { DEFAULT_AGENT_ENGINE } from '@core/shared/agent-engine.js';

function reviewedGithubRuntimeAccess(): CapabilityRuntimeAccess[] {
  return [
    {
      selectedCapabilityId: 'github.issues.create',
      sourceType: 'mcp_server',
      auditLabel: 'GitHub issues create',
      reviewedServerId: 'github',
      allowedTools: [
        'mcp__github__issues.create',
        'mcp__github__search_repositories',
      ],
      credentialRefs: [],
      networkHosts: [],
    },
  ];
}

function githubMcpRecord(
  transport: 'stdio_template' | 'http' = 'stdio_template',
): MaterializedMcpServer {
  const definition: MaterializedMcpServer['definition'] = {
    id: 'mcp:github' as never,
    appId: 'app-one' as never,
    name: 'github',
    status: 'active',
    createdSource: 'admin',
    riskClass: 'medium',
    transport,
    config:
      transport === 'stdio_template'
        ? {
            transport: 'stdio_template',
            templateId: 'npx-package',
            args: ['@modelcontextprotocol/server-github'],
          }
        : { transport: 'http', url: 'https://api.github.com/mcp' },
    allowedToolPatterns: ['issues.*', 'search_*'],
    autoApproveToolPatterns: [],
    credentialRefs: [],
    networkHosts: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  return {
    definition,
    binding: {
      id: 'agent-mcp-binding:one' as never,
      appId: 'app-one' as never,
      agentId: 'agent-one' as never,
      serverId: definition.id,
      status: 'active',
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: ['issues.*', 'search_*'],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  };
}

describe('agent spawn runtime policy', () => {
  const envKey = (suffix: string) => ['ANTHROPIC', suffix].join('_');

  it('normalizes IPv6 loopback model gateway authorities', () => {
    expect(loopbackAuthorityFromUrl('http://[::1]:4567/anthropic')).toBe(
      '[::1]:4567',
    );
  });

  it('normalizes Postgres database URLs into sandbox network hosts', () => {
    expect(
      databaseNetworkHostFromUrl('postgres://gantry:test@db.internal/gantry'),
    ).toBe('db.internal:5432');
    expect(
      databaseNetworkHostFromUrl(
        'postgresql://gantry:test@[2001:db8::1]:6543/gantry',
      ),
    ).toBe('[2001:db8::1]:6543');
    expect(databaseNetworkHostFromUrl('https://db.internal')).toBeUndefined();
    expect(databaseNetworkHostFromUrl('not a url')).toBeUndefined();
  });

  it('rewrites loopback model gateway env to a sandbox proxy-visible alias', () => {
    const projection = projectSandboxRuntimeModelGatewayEnv({
      [envKey('BASE_URL')]: 'http://127.0.0.1:4567/anthropic',
      [envKey('API_KEY')]: 'gtw_test',
    });

    expect(projection.modelCredentialEnv).toMatchObject({
      [envKey('BASE_URL')]:
        `http://${SANDBOX_RUNTIME_MODEL_GATEWAY_HOST}:4567/anthropic`,
      [envKey('API_KEY')]: 'gtw_test',
    });
    expect(projection.allowedNetworkHosts).toEqual([
      `${SANDBOX_RUNTIME_MODEL_GATEWAY_HOST}:4567`,
    ]);
    expect(projection.privateNetworkHostMappings).toEqual([
      {
        authority: `${SANDBOX_RUNTIME_MODEL_GATEWAY_HOST}:4567`,
        connectHost: '127.0.0.1',
      },
    ]);
  });

  it('passes non-secret DeepAgents prepared env to the runner', () => {
    expect(
      pickPreparedExecutionEnv({
        GANTRY_DEEPAGENTS_MODEL_ID: 'gpt-5.5',
        GANTRY_DEEPAGENTS_MODEL_PROVIDER: 'openai',
        GANTRY_DEEPAGENTS_CACHE_PROMPT_CONTROL: 'automatic',
        GANTRY_DEEPAGENTS_MAX_INPUT_TOKENS: '400000',
        GANTRY_DEEPAGENTS_CHECKPOINT_DATABASE_URL:
          'postgres://secret@localhost/db',
      }),
    ).toEqual({
      GANTRY_DEEPAGENTS_MODEL_ID: 'gpt-5.5',
      GANTRY_DEEPAGENTS_MODEL_PROVIDER: 'openai',
      GANTRY_DEEPAGENTS_CACHE_PROMPT_CONTROL: 'automatic',
      GANTRY_DEEPAGENTS_MAX_INPUT_TOKENS: '400000',
    });
  });

  it('does not project reviewed third-party MCP sources for DeepAgents', () => {
    const projection = resolveRunnerMcpProjection('deepagents', {
      runtimeAccess: reviewedGithubRuntimeAccess(),
      mcpSourceRecords: [githubMcpRecord()],
    });

    expect(projection).toEqual({
      reviewedMcpToolNames: [],
      projectedMcpSourceIds: [],
    });
  });

  it('projects reviewed stdio MCP sources for the Anthropic SDK runner', () => {
    const projection = resolveRunnerMcpProjection(DEFAULT_AGENT_ENGINE, {
      runtimeAccess: reviewedGithubRuntimeAccess(),
      mcpSourceRecords: [githubMcpRecord()],
    });

    expect(projection).toEqual({
      reviewedMcpToolNames: [
        'mcp__github__issues.create',
        'mcp__github__search_repositories',
      ],
      projectedMcpSourceIds: ['mcp:github'],
    });
  });

  it('does not directly project remote MCP sources to runner config', () => {
    const projection = resolveRunnerMcpProjection(DEFAULT_AGENT_ENGINE, {
      runtimeAccess: reviewedGithubRuntimeAccess(),
      mcpSourceRecords: [githubMcpRecord('http')],
    });

    expect(projection).toEqual({
      reviewedMcpToolNames: [],
      projectedMcpSourceIds: [],
    });
  });
});
