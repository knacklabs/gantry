import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { McpServerService } from '@core/application/mcp/mcp-server-service.js';
import type { PostgresIntegrationRuntime } from '../harness/postgres-integration-runtime.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
} from '../harness/postgres-integration-runtime.js';

describe.runIf(hasPostgresIntegrationDatabase)(
  'MCP server Postgres integration',
  () => {
    let runtime: PostgresIntegrationRuntime;

    beforeEach(async () => {
      runtime = await createPostgresIntegrationRuntime({
        schemaPrefix: 'mcp',
      });
      const now = new Date().toISOString();
      await runtime.repositories.apps.saveApp({
        id: 'app-one' as never,
        slug: 'app-one',
        name: 'App One',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await runtime.repositories.agents.saveAgent({
        id: 'agent:one' as never,
        appId: 'app-one' as never,
        name: 'Agent One',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    }, 30_000);

    afterEach(async () => {
      if (runtime) await runtime.cleanup();
    });

    it('persists connected definitions, bindings, materialization, and audit events in isolated schema', async () => {
      const service = new McpServerService(
        runtime.repositories.mcpServers,
        runtime.repositories.agents,
      );

      const created = await service.connectServer({
        appId: 'app-one' as never,
        name: 'linear',
        transportConfig: {
          transport: 'stdio_template',
          templateId: 'npx-package',
          args: ['@modelcontextprotocol/server-linear'],
        },
        sandboxProfileId: 'sandbox:mcp-linear',
        allowedToolPatterns: ['search_issues'],
        autoApproveToolPatterns: ['search_issues'],
        credentialRefs: [
          { name: 'LINEAR_TOKEN_REF', target: 'env', key: 'LINEAR_TOKEN' },
        ],
        createdBy: 'admin-user',
      });
      await service.bindToAgent({
        appId: 'app-one' as never,
        agentId: 'agent:one' as never,
        serverId: created.id,
      });

      const materialized = await service.materializeForAgent({
        appId: 'app-one' as never,
        agentId: 'agent:one' as never,
        credentialEnv: { LINEAR_TOKEN_REF: 'broker-safe-linear-token' },
      });
      expect(materialized).toHaveLength(1);
      expect(materialized[0]).toMatchObject({
        name: 'linear',
        serverId: created.id,
        bindingId: expect.stringContaining(
          `agent-mcp-binding:agent:one:${created.id}`,
        ),
        sourceRevision: expect.stringContaining(created.id),
        config: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-linear'],
          env: { LINEAR_TOKEN: 'broker-safe-linear-token' },
        },
        allowedToolNames: ['mcp__linear__search_issues'],
        allowedToolPatterns: ['search_issues'],
        autoApproveToolNames: ['mcp__linear__search_issues'],
        autoApproveToolPatterns: ['search_issues'],
        networkHosts: [],
        required: false,
      });

      const second = await service.connectServer({
        appId: 'app-one' as never,
        name: 'github',
        transportConfig: {
          transport: 'stdio_template',
          templateId: 'npx-package',
          args: ['@modelcontextprotocol/server-github'],
        },
        sandboxProfileId: 'sandbox:mcp-github',
        allowedToolPatterns: ['search_repositories'],
      });
      await service.bindToAgent({
        appId: 'app-one' as never,
        agentId: 'agent:one' as never,
        serverId: second.id,
      });
      const appTwoNow = new Date().toISOString();
      await runtime.repositories.apps.saveApp({
        id: 'app-two' as never,
        slug: 'app-two',
        name: 'App Two',
        status: 'active',
        createdAt: appTwoNow,
        updatedAt: appTwoNow,
      });
      const otherAppServer = await service.connectServer({
        appId: 'app-two' as never,
        name: 'other_app_server',
        transportConfig: {
          transport: 'stdio_template',
          templateId: 'npx-package',
          args: ['@modelcontextprotocol/server-other'],
        },
        sandboxProfileId: 'sandbox:mcp-other',
      });
      await runtime.repositories.mcpServers.saveAgentBinding({
        id: `agent-mcp-binding:agent:one:${otherAppServer.id}` as never,
        appId: 'app-one' as never,
        agentId: 'agent:one' as never,
        serverId: otherAppServer.id,
        status: 'active',
        required: false,
        permissionPolicyIds: [],
        allowedToolPatterns: [],
        createdAt: appTwoNow as never,
        updatedAt: appTwoNow as never,
      });

      await expect(
        runtime.repositories.mcpServers.listMaterializedServersForAgent({
          appId: 'app-one' as never,
          agentId: 'agent:one' as never,
        }),
      ).resolves.toHaveLength(2);
      await expect(
        runtime.repositories.mcpServers.listMaterializedServersForAgent({
          appId: 'app-one' as never,
          agentId: 'agent:one' as never,
          serverIds: [created.id],
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          definition: expect.objectContaining({ id: created.id }),
        }),
      ]);
      await expect(
        runtime.repositories.mcpServers.listMaterializedServersForAgent({
          appId: 'app-one' as never,
          agentId: 'agent:one' as never,
          serverIds: [otherAppServer.id],
        }),
      ).resolves.toEqual([]);
      await expect(
        service.materializeForAgent({
          appId: 'app-one' as never,
          agentId: 'agent:one' as never,
          serverIds: [created.id],
          credentialEnv: { LINEAR_TOKEN_REF: 'broker-safe-linear-token' },
        }),
      ).resolves.toHaveLength(1);
      await expect(
        service.materializeForAgent({
          appId: 'app-one' as never,
          agentId: 'agent:one' as never,
          serverIds: [],
          credentialEnv: { LINEAR_TOKEN_REF: 'broker-safe-linear-token' },
        }),
      ).resolves.toEqual([]);
      await expect(
        runtime.repositories.mcpServers.listAuditEvents({
          appId: 'app-one' as never,
          serverId: created.id,
        }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ eventType: 'connect' }),
          expect.objectContaining({ eventType: 'bind' }),
          expect.objectContaining({ eventType: 'materialize' }),
        ]),
      );
    });

    it('applies paginated MCP listings and conditional lifecycle transitions', async () => {
      const service = new McpServerService(
        runtime.repositories.mcpServers,
        runtime.repositories.agents,
      );
      const first = await service.connectServer({
        appId: 'app-one' as never,
        name: 'first_page',
        transportConfig: {
          transport: 'http',
          url: 'https://93.184.216.34/first',
        },
      });
      await service.connectServer({
        appId: 'app-one' as never,
        name: 'second_page',
        transportConfig: {
          transport: 'http',
          url: 'https://93.184.216.34/second',
        },
      });

      const firstPage = await service.listServers({
        appId: 'app-one' as never,
        statuses: ['active'],
        limit: 1,
      });
      expect(firstPage).toHaveLength(1);
      await service.disableServer({
        appId: 'app-one' as never,
        serverId: first.id,
        reason: 'not needed',
      });
      await expect(
        service.bindToAgent({
          appId: 'app-one' as never,
          agentId: 'agent:one' as never,
          serverId: first.id,
        }),
      ).rejects.toThrow(/must be active/);
    });
  },
);

describe.skipIf(hasPostgresIntegrationDatabase)(
  'MCP server Postgres integration',
  () => {
    it('skips when GANTRY_TEST_DATABASE_URL is absent', () => {
      expect(process.env.GANTRY_TEST_DATABASE_URL).toBeUndefined();
    });
  },
);
