import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { McpServerService } from '@core/application/mcp/mcp-server-service.js';
import { McpToolProxy } from '@core/application/mcp/mcp-tool-proxy.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import type { McpServerDefinition } from '@core/domain/mcp/mcp-servers.js';

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
const SERVER_NAME = 'e2e-sum';
const APPROVED_TOOL_RULE = `mcp__${SERVER_NAME}__get-sum`;

// Matrix §5, non-model part: the fixture Streamable HTTP MCP server is
// registered through the real management surface (McpServerService, the same
// service mcp-server routes use) with ONLY `get-sum` approved, then invoked
// through gantry's REAL client path (McpToolProxy — the exact class the
// runtime constructs in ipc-admin-handlers.ts / control routes, including the
// production `liveToolRules` approval input). Model involvement: none.
maybeDescribe('MCP client loop through the real proxy (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let fixture: McpTestServer;
  let server: McpServerDefinition;
  let proxy: McpToolProxy;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'mcp_client_loop',
    });
    fixture = await startMcpTestServer();
    const service = new McpServerService(
      runtime.repositories.mcpServers,
      runtime.repositories.agents,
    );
    server = await service.connectServer({
      appId: APP_ID as never,
      name: SERVER_NAME,
      transportConfig: { transport: 'http', url: fixture.url },
      // ONLY get-sum approved; `echo` stays denied at the source scope.
      allowedToolPatterns: ['get-sum'],
      createdBy: 'agent-e2e-gate',
    });
    await service.bindToAgent({
      appId: APP_ID as never,
      agentId: AGENT_ID as never,
      serverId: server.id,
    });
    proxy = new McpToolProxy(runtime.repositories.mcpServers, {
      tools: runtime.repositories.tools,
      skills: runtime.repositories.skills,
      liveToolRules: [APPROVED_TOOL_RULE],
      publishRuntimeEvent: (event) =>
        runtime.storageRuntime.runtimeEvents.publish(event),
    });
  }, 60_000);

  afterAll(async () => {
    if (fixture) await fixture.stop();
    if (runtime) await runtime.cleanup();
  });

  it('calls get-sum(20,22) through the proxy; fixture records exact args and the result is 42', async () => {
    const result = (await proxy.callTool({
      appId: APP_ID as never,
      agentId: AGENT_ID as never,
      serverName: SERVER_NAME,
      toolName: 'get-sum',
      arguments: { a: 20, b: 22 },
    })) as { content: Array<{ type: string; text: string }> };

    // Fixture-side truth: exactly one invocation with the exact args.
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toMatchObject({
      name: 'get-sum',
      args: { a: 20, b: 22 },
    });
    expect(result.content[0]).toMatchObject({ type: 'text', text: '42' });

    // MCP audit trail (durable authority for tool-call evidence).
    const auditEvents = await runtime.repositories.mcpServers.listAuditEvents({
      appId: APP_ID as never,
      limit: 100,
    });
    const success = auditEvents.find(
      (event) =>
        event.eventType === 'tool_activity' &&
        (event.metadata as { resultClass?: string }).resultClass === 'success',
    );
    expect(success).toBeDefined();
    expect(success!.metadata).toMatchObject({
      serverName: SERVER_NAME,
      toolName: 'get-sum',
      requestedToolRule: APPROVED_TOOL_RULE,
      selectedToolRule: APPROVED_TOOL_RULE,
    });

    // Runtime event projection emitted by the same call path.
    const runtimeEvents =
      await runtime.repositories.runtimeEvents.listRuntimeEvents({
        appId: APP_ID as never,
        eventTypes: [RUNTIME_EVENT_TYPES.MCP_TOOL_ACTIVITY],
        limit: 100,
      });
    expect(
      runtimeEvents.some(
        (event) =>
          (event.payload as { toolName?: string; resultClass?: string })
            .toolName === 'get-sum' &&
          (event.payload as { resultClass?: string }).resultClass === 'success',
      ),
    ).toBe(true);
  });

  it('keeps the denied tool `echo` out of the projected tool surface and refuses to call it', async () => {
    const listed = await proxy.listTools({
      appId: APP_ID as never,
      agentId: AGENT_ID as never,
      serverName: SERVER_NAME,
    });
    const projectedNames = listed.servers.flatMap((entry) =>
      entry.tools.map((tool) => tool.name),
    );
    expect(projectedNames).toContain('get-sum');
    expect(projectedNames).not.toContain('echo');

    const callsBefore = fixture.calls.length;
    await expect(
      proxy.callTool({
        appId: APP_ID as never,
        agentId: AGENT_ID as never,
        serverName: SERVER_NAME,
        toolName: 'echo',
        arguments: { value: 'should-never-arrive' },
      }),
    ).rejects.toThrow(/not approved/);
    // The fixture never saw the denied call.
    expect(fixture.calls).toHaveLength(callsBefore);

    const auditEvents = await runtime.repositories.mcpServers.listAuditEvents({
      appId: APP_ID as never,
      limit: 100,
    });
    expect(
      auditEvents.some(
        (event) =>
          event.eventType === 'tool_activity' &&
          (event.metadata as { toolName?: string }).toolName === 'echo' &&
          (event.metadata as { resultClass?: string }).resultClass === 'denied',
      ),
    ).toBe(true);
  });
});
