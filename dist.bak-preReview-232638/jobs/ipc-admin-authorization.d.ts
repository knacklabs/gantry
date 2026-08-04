import type { TaskContext } from './ipc-types.js';
import { type AdminMcpToolName } from '../shared/admin-mcp-tools.js';
export declare function sourceAgentHasAdminToolCapability(context: Pick<TaskContext, 'data' | 'deps' | 'sourceAgentFolder' | 'ipcBaseDir'>, toolName: AdminMcpToolName): Promise<boolean>;
export declare function adminCapabilityRequiredMessage(toolName: AdminMcpToolName): string;
