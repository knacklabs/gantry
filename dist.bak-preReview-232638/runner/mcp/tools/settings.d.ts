import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdminMcpToolName } from '../../../shared/admin-mcp-tools.js';
export declare function registerSettingsTools(server: McpServer, options: {
    isAdminToolEnabled: (toolName: AdminMcpToolName) => boolean;
}): void;
