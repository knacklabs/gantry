/**
 * Stdio MCP Server for Gantry.
 * Standalone process that agent teams subagents can inherit.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGantryMcpServer } from './server.js';
const server = createGantryMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
