import { describe, expect, it } from 'vitest';

import { composeAgentCapabilities } from '@core/adapters/llm/anthropic-claude-agent/agent-capabilities.js';
import { buildGantryMcpProjection } from '@core/adapters/llm/deepagents-langchain/runner/gantry-mcp-env.js';
import {
  gantryMcpFullToolName,
  parseEnabledGantryMcpToolNames,
  selectedGantryMcpToolNames,
} from '@core/runner/gantry-mcp-tool-surface.js';

const CANVAS_TOOL_NAMES = [
  'canvas_read',
  'canvas_create',
  'canvas_update',
] as const;
const CONFIGURED_CANVAS_TOOLS = CANVAS_TOOL_NAMES.map(gantryMcpFullToolName);

function expectCanvasToolsAbsent(names: Iterable<string>): void {
  const selected = new Set(names);
  for (const toolName of CANVAS_TOOL_NAMES) {
    expect(selected.has(toolName)).toBe(false);
    expect(selected.has(gantryMcpFullToolName(toolName))).toBe(false);
  }
}

function expectCanvasToolsPresent(names: Iterable<string>): void {
  const selected = new Set(names);
  for (const toolName of CANVAS_TOOL_NAMES) {
    expect(
      selected.has(toolName) || selected.has(gantryMcpFullToolName(toolName)),
    ).toBe(true);
  }
}

describe('gantry mcp tool surface', () => {
  it('drops provider-affinity tools for conversations on other providers in both selection paths', async () => {
    process.env.GANTRY_IPC_DIR = '/tmp/gantry-tools-1-1';
    const { effectiveEnabledMcpToolNames } =
      await import('@core/runner/mcp/server.js');
    for (const chatJid of [
      'tg:conversation',
      'dc:conversation',
      'teams:conversation',
      'app:conversation',
      'unknown:conversation',
    ]) {
      expectCanvasToolsAbsent(
        selectedGantryMcpToolNames(CONFIGURED_CANVAS_TOOLS, { chatJid }),
      );
      expectCanvasToolsAbsent(
        parseEnabledGantryMcpToolNames(JSON.stringify(CANVAS_TOOL_NAMES), {
          chatJid,
        }),
      );
      expectCanvasToolsAbsent(
        effectiveEnabledMcpToolNames(
          JSON.stringify(CANVAS_TOOL_NAMES),
          undefined,
          undefined,
          false,
          undefined,
          chatJid,
        ),
      );

      const anthropic = composeAgentCapabilities({
        mcpServerPath: '/runner/mcp/stdio.js',
        chatJid,
        workspaceFolder: 'workspace',
        configuredAllowedTools: CONFIGURED_CANVAS_TOOLS,
      });
      expectCanvasToolsAbsent(anthropic.allowedTools);
      expectCanvasToolsAbsent(
        JSON.parse(
          String(anthropic.mcpServers.gantry?.env?.GANTRY_MCP_TOOL_NAMES_JSON),
        ) as string[],
      );

      const deepAgents = buildGantryMcpProjection({
        configuredAllowedTools: CONFIGURED_CANVAS_TOOLS,
        hideAuthorityTools: false,
        processEnv: { GANTRY_CHAT_JID: chatJid },
      });
      expectCanvasToolsAbsent(deepAgents.selectedToolNames);
      expectCanvasToolsAbsent(
        JSON.parse(deepAgents.env.GANTRY_MCP_TOOL_NAMES_JSON) as string[],
      );
    }

    const scheduledAnthropic = composeAgentCapabilities({
      mcpServerPath: '/runner/mcp/stdio.js',
      chatJid: 'sl:conversation',
      workspaceFolder: 'workspace',
      configuredAllowedTools: CONFIGURED_CANVAS_TOOLS,
      isScheduledJob: true,
      jobId: 'job-1',
    });
    expectCanvasToolsPresent(scheduledAnthropic.allowedTools);
    expectCanvasToolsPresent(
      JSON.parse(
        String(
          scheduledAnthropic.mcpServers.gantry?.env?.GANTRY_MCP_TOOL_NAMES_JSON,
        ),
      ) as string[],
    );

    const scheduledDeepAgents = buildGantryMcpProjection({
      configuredAllowedTools: CONFIGURED_CANVAS_TOOLS,
      hideAuthorityTools: false,
      processEnv: {
        GANTRY_CHAT_JID: 'sl:conversation',
        GANTRY_JOB_ID: 'job-1',
      },
    });
    expectCanvasToolsPresent(scheduledDeepAgents.selectedToolNames);
    expectCanvasToolsPresent(
      JSON.parse(
        scheduledDeepAgents.env.GANTRY_MCP_TOOL_NAMES_JSON,
      ) as string[],
    );
  });
});
