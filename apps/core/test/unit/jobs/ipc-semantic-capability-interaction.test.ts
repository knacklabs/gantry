import { describe, expect, it } from 'vitest';

import { buildPermissionPromptParts } from '@core/channels/permission-interaction.js';
import { buildTeamsApprovalAdaptiveCard } from '@core/channels/teams-cards.js';
import { semanticCapabilityInteraction } from '@core/jobs/ipc-semantic-capability-interaction.js';

describe('semantic MCP capability review interaction', () => {
  it('puts the complete canonical MCP scope in the prompt full view', () => {
    const tools = Array.from(
      { length: 55 },
      (_, index) => `sensitive_tool_${String(index).padStart(2, '0')}`,
    );
    const toolInput = {
      capabilityId: 'mcp.fixture.read.123456789abc',
      capabilityDisplayName: 'Fixture read access',
      credentialSource: 'none',
      mcpServerName: 'fixture',
      mcpToolPatterns: tools,
      mcpResolvedTools: tools,
      risk: 'read',
    };
    const interaction = semanticCapabilityInteraction(
      { toolName: 'request_permission', toolInput },
      'request-1',
    );
    const parts = buildPermissionPromptParts(
      {
        requestId: 'request-1',
        appId: 'app:test',
        agentId: 'agent:test',
        sourceAgentFolder: 'main_agent',
        targetJid: 'sl:C123',
        toolName: 'request_permission',
        toolInput,
        interaction,
      } as never,
      300_000,
    );

    expect(parts.fullView).toMatchObject({
      label: 'View MCP scope',
      filename: 'mcp-capability-scope.txt',
    });
    for (const toolName of tools) {
      expect(parts.fullView?.content).toContain(`- ${toolName}`);
    }

    const teamsCard = buildTeamsApprovalAdaptiveCard({
      requestId: 'request-1',
      appId: 'app:test',
      agentId: 'agent:test',
      sourceAgentFolder: 'main_agent',
      targetJid: 'ms:conversation',
      toolName: 'request_permission',
      toolInput,
      interaction,
    } as never);
    const teamsPrompt = String(teamsCard.body[1]?.text);
    expect(teamsPrompt).toContain(`- ${tools[0]}`);
    expect(teamsPrompt).toContain(`- ${tools.at(-1)}`);
    expect(teamsPrompt).not.toContain(
      '[additional permission details omitted]',
    );
  });
});
