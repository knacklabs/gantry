import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/index.js';
import { McpServerService } from '@core/application/mcp/mcp-server-service.js';
import { McpToolProxy } from '@core/application/mcp/mcp-tool-proxy.js';
import type { McpServerDefinition } from '@core/domain/mcp/mcp-servers.js';
import { adminTaskHandlers } from '@core/jobs/ipc-admin-handlers.js';
import { semanticCapabilityFromToolCatalogItem } from '@core/shared/semantic-capabilities.js';

import {
  startMcpTestServer,
  type McpTestServer,
} from '../agent-e2e/fixtures/mcp-test-server.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const APP_ID = 'default';
const AGENT_ID = 'agent:main_agent';
const AGENT_FOLDER = 'main_agent';
const SERVER_NAME = 'e2e-sum';

maybeDescribe('MCP capability authoring (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let fixture: McpTestServer;
  let server: McpServerDefinition;
  let proxy: McpToolProxy;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'mcp_capability_authoring',
    });
    _setRuntimeStorageForTest(runtime.storageRuntime);
    fixture = await startMcpTestServer();
    const mcpServers = new McpServerService(
      runtime.repositories.mcpServers,
      runtime.repositories.agents,
    );
    server = await mcpServers.connectServer({
      appId: APP_ID as never,
      name: SERVER_NAME,
      transportConfig: { transport: 'http', url: fixture.url },
      allowedToolPatterns: ['get-sum', 'echo'],
      createdBy: 'mcp-capability-authoring-test',
    });
    await mcpServers.bindToAgent({
      appId: APP_ID as never,
      agentId: AGENT_ID as never,
      serverId: server.id,
    });
    proxy = new McpToolProxy(runtime.repositories.mcpServers, {
      tools: runtime.repositories.tools,
      skills: runtime.repositories.skills,
    });
  }, 60_000);

  afterAll(async () => {
    if (fixture) await fixture.stop();
    if (runtime) await runtime.cleanup();
  });

  it('mints MCP authority only from a permanent human approval', async () => {
    const call = (through = proxy) =>
      through.callTool({
        appId: APP_ID as never,
        agentId: AGENT_ID as never,
        serverName: SERVER_NAME,
        toolName: 'get-sum',
        arguments: { a: 20, b: 22 },
      });

    await expect(call()).rejects.toThrow(/not approved/);
    expect(fixture.calls).toHaveLength(0);

    const outsideScope = await requestCapability({
      tools: ['search_delete'],
      risk: 'write',
      displayName: 'Delete search records',
      mode: 'cancel',
      expectPrompt: false,
    });
    expect(outsideScope.requestPermissionApproval).not.toHaveBeenCalled();

    const allowOnce = await requestCapability({
      tools: ['get-sum'],
      risk: 'write',
      displayName: 'E2E sum read',
      mode: 'allow_once',
    });
    const candidate = Object.values(
      allowOnce.request!.semanticCapabilityDefinitions ?? {},
    )[0]!;
    const capabilityRule = `capability:${candidate.capabilityId}`;
    const capabilityToolId = `tool:${capabilityRule}`;

    const expectNoDurableAuthority = async () => {
      expect(
        await runtime.repositories.tools.getTool(capabilityToolId as never),
      ).toBeNull();
      const grants = await runtime.repositories.tools.listAgentToolBindings({
        appId: APP_ID as never,
        agentId: AGENT_ID as never,
      });
      expect(
        grants.some(
          (grant) =>
            grant.status === 'active' && grant.toolId === capabilityToolId,
        ),
      ).toBe(false);
    };

    await expectNoDurableAuthority();
    await expect(call()).rejects.toThrow(/not approved/);

    const denied = await requestCapability({
      tools: ['get-sum'],
      risk: 'write',
      displayName: 'E2E sum read',
      mode: 'cancel',
    });
    expect(denied.requestPermissionApproval).toHaveBeenCalledTimes(1);
    await expectNoDurableAuthority();
    await expect(call()).rejects.toThrow(/not approved/);
    expect(fixture.calls).toHaveLength(0);

    const permanent = await requestCapability({
      tools: ['get-sum'],
      risk: 'write',
      displayName: 'E2E sum read',
      mode: 'allow_persistent_rule',
    });
    expect(permanent.request).toMatchObject({
      decisionPolicy: 'same_channel',
      decisionOptions: ['allow_once', 'allow_persistent_rule', 'cancel'],
      interaction: {
        details: expect.arrayContaining([
          { label: 'Server', value: SERVER_NAME },
          { label: 'Resolved tools', value: 'get-sum' },
          // Host-derived risk: the fixture server is not registered low-risk,
          // so even a read-shaped pattern classifies as write (fail-closed).
          { label: 'Risk', value: 'write' },
        ]),
      },
    });

    const catalogItem = await runtime.repositories.tools.getTool(
      capabilityToolId as never,
    );
    expect(catalogItem).not.toBeNull();
    const persistedDefinition = semanticCapabilityFromToolCatalogItem({
      name: catalogItem!.name,
      inputSchema: catalogItem!.inputSchema,
    });
    expect(persistedDefinition).toMatchObject({
      capabilityId: candidate.capabilityId,
      risk: 'write',
      implementationBindings: [
        {
          kind: 'mcp_pattern',
          mcpServer: SERVER_NAME,
          mcpToolPatterns: ['get-sum'],
        },
      ],
    });
    expect(persistedDefinition!.implementationBindings).toHaveLength(1);

    const grants = await runtime.repositories.tools.listAgentToolBindings({
      appId: APP_ID as never,
      agentId: AGENT_ID as never,
    });
    expect(grants).toContainEqual(
      expect.objectContaining({
        toolId: capabilityToolId,
        status: 'active',
      }),
    );
    const sourceBindings =
      await runtime.repositories.mcpServers.listAgentBindings({
        appId: APP_ID as never,
        agentId: AGENT_ID as never,
      });
    expect(sourceBindings).toContainEqual(
      expect.objectContaining({
        serverId: server.id,
        status: 'active',
      }),
    );

    const decisions = await runtime.service.db
      .select()
      .from(pgSchema.permissionDecisionsPostgres)
      .where(eq(pgSchema.permissionDecisionsPostgres.appId, APP_ID));
    const recordedDecision = decisions.find((decision) => {
      const context = JSON.parse(decision.actorContextJson ?? 'null') as {
        requestId?: string;
      } | null;
      return context?.requestId === permanent.request!.requestId;
    });
    expect(
      JSON.parse(recordedDecision!.actorContextJson ?? 'null'),
    ).toMatchObject({
      mode: 'allow_persistent_rule',
      classification: 'user_permanent',
    });

    const result = (await call()) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]).toMatchObject({ type: 'text', text: '42' });
    expect(fixture.calls).toEqual([
      expect.objectContaining({
        name: 'get-sum',
        args: { a: 20, b: 22 },
      }),
    ]);
  });

  async function requestCapability(input: {
    tools: string[];
    risk: 'read' | 'write';
    displayName: string;
    mode: 'allow_once' | 'allow_persistent_rule' | 'cancel';
    expectPrompt?: boolean;
  }) {
    let request: Record<string, any> | undefined;
    const sendMessage = vi.fn(async () => undefined);
    const requestPermissionApproval = vi.fn(async (nextRequest: any) => {
      request = nextRequest;
      if (input.mode === 'cancel') {
        return {
          kind: 'decision' as const,
          decision: {
            approved: false,
            mode: 'cancel' as const,
            reason: 'not approved',
          },
        };
      }
      return {
        kind: 'decision' as const,
        decision: {
          approved: true,
          mode: input.mode,
          decidedBy: 'user:approver',
          decisionClassification:
            input.mode === 'allow_persistent_rule'
              ? ('user_permanent' as const)
              : ('user_temporary' as const),
          updatedPermissions: nextRequest.suggestions ?? [],
        },
      };
    });
    await adminTaskHandlers.request_permission({
      data: {
        type: 'request_permission',
        appId: APP_ID,
        chatJid: 'tg:mcp-capability-authoring',
        payload: {
          permissionKind: 'tool',
          capabilityRequestSource: 'request_access',
          capabilityProposalKind: 'mcp_capability',
          mcpServerName: SERVER_NAME,
          mcpToolPatterns: input.tools,
          risk: input.risk,
          capabilityDisplayName: input.displayName,
          temporaryOnly: false,
          reason: 'Exercise the reviewed MCP capability flow.',
        },
      },
      sourceAgentFolder: AGENT_FOLDER,
      deps: {
        requestPermissionApproval,
        sendMessage,
        getToolRepository: () => runtime.repositories.tools,
        getSkillRepository: () => runtime.repositories.skills,
        getMcpServerRepository: () => runtime.repositories.mcpServers,
        getPermissionRepository: () => runtime.repositories.permissions,
        mirrorAgentToolRulesToSettings: async () => {},
      } as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['tg:mcp-capability-authoring'],
    });
    // The capability review is fire-and-forget: it awaits a Postgres
    // insertPending before it builds semanticCapabilityDefinitions and invokes
    // the approval mock. In-scope proposals must therefore WAIT for the mock
    // rather than read it eagerly (the old conditional guard returned before the
    // review had run against real Postgres, leaving `request` undefined).
    if (input.expectPrompt ?? true) {
      await vi.waitFor(() =>
        expect(requestPermissionApproval).toHaveBeenCalledTimes(1),
      );
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    }
    return { request, requestPermissionApproval, sendMessage };
  }
});
