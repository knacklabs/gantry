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

    it('persists approved definitions, bindings, materialization, and audit events in isolated schema', async () => {
      const service = new McpServerService(
        runtime.repositories.mcpServers,
        runtime.repositories.agents,
      );

      const created = await service.createDraft({
        appId: 'app-one' as never,
        name: 'linear',
        transportConfig: {
          transport: 'sse',
          url: 'https://93.184.216.34/linear',
        },
        allowedToolPatterns: ['search_issues'],
        autoApproveToolPatterns: ['search_issues'],
        credentialRefs: [
          { name: 'LINEAR_TOKEN_REF', target: 'header', key: 'Authorization' },
        ],
        createdBy: 'admin-user',
      });
      await service.approveDraft({
        appId: 'app-one' as never,
        serverId: created.definition.id,
        approvedBy: 'reviewer',
      });
      await expect(
        runtime.repositories.mcpServers.getVersion(created.version.id),
      ).resolves.toMatchObject({
        reviewedBy: 'reviewer',
        reviewedAt: expect.any(String),
      });
      await service.bindToAgent({
        appId: 'app-one' as never,
        agentId: 'agent:one' as never,
        serverId: created.definition.id,
      });

      const materialized = await service.materializeForAgent({
        appId: 'app-one' as never,
        agentId: 'agent:one' as never,
        credentialEnv: { LINEAR_TOKEN_REF: 'broker-safe-linear-token' },
      });
      expect(materialized).toEqual([
        {
          name: 'linear',
          config: {
            type: 'sse',
            url: 'https://93.184.216.34/linear',
            headers: { Authorization: 'broker-safe-linear-token' },
          },
          allowedToolNames: ['mcp__linear__search_issues'],
          allowedToolPatterns: ['search_issues'],
          autoApproveToolNames: ['mcp__linear__search_issues'],
          autoApproveToolPatterns: ['search_issues'],
          required: false,
        },
      ]);

      await expect(
        runtime.repositories.mcpServers.listMaterializedServersForAgent({
          appId: 'app-one' as never,
          agentId: 'agent:one' as never,
        }),
      ).resolves.toHaveLength(1);
      await expect(
        runtime.repositories.mcpServers.listAuditEvents({
          appId: 'app-one' as never,
          serverId: created.definition.id,
        }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ eventType: 'request' }),
          expect.objectContaining({ eventType: 'approve' }),
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
      const first = await service.createDraft({
        appId: 'app-one' as never,
        name: 'first_page',
        transportConfig: {
          transport: 'http',
          url: 'https://93.184.216.34/first',
        },
      });
      await service.createDraft({
        appId: 'app-one' as never,
        name: 'second_page',
        transportConfig: {
          transport: 'http',
          url: 'https://93.184.216.34/second',
        },
      });

      const firstPage = await service.listServers({
        appId: 'app-one' as never,
        statuses: ['draft'],
        limit: 1,
      });
      expect(firstPage).toHaveLength(1);
      await service.rejectDraft({
        appId: 'app-one' as never,
        serverId: first.definition.id,
        reason: 'not needed',
      });
      await expect(
        service.approveDraft({
          appId: 'app-one' as never,
          serverId: first.definition.id,
        }),
      ).rejects.toThrow(/Only draft/);
    });
  },
);

describe.skipIf(hasPostgresIntegrationDatabase)(
  'MCP server Postgres integration',
  () => {
    it('skips when MYCLAW_TEST_DATABASE_URL is absent', () => {
      expect(process.env.MYCLAW_TEST_DATABASE_URL).toBeUndefined();
    });
  },
);
