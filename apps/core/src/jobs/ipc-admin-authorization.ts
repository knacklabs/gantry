import {
  DEFAULT_MEMORY_APP_ID,
  memoryAgentIdForGroupFolder,
} from '../memory/app-memory-boundaries.js';
import type { TaskContext } from './ipc-types.js';
import {
  adminMcpToolFullName,
  adminMcpToolIdForFullName,
  type AdminMcpToolName,
} from '../shared/admin-mcp-tools.js';

export async function sourceAgentHasAdminToolCapability(
  context: Pick<TaskContext, 'deps' | 'sourceGroup'>,
  toolName: AdminMcpToolName,
): Promise<boolean> {
  const repository = context.deps.getToolRepository?.();
  if (!repository) return false;
  const fullName = adminMcpToolFullName(toolName);
  const toolId = adminMcpToolIdForFullName(fullName);
  const bindings = await repository.listAgentToolBindings({
    appId: DEFAULT_MEMORY_APP_ID as never,
    agentId: memoryAgentIdForGroupFolder(context.sourceGroup) as never,
  });
  return bindings.some(
    (binding) =>
      binding.status === 'active' && String(binding.toolId) === toolId,
  );
}

export function adminCapabilityRequiredMessage(
  toolName: AdminMcpToolName,
): string {
  const fullName = adminMcpToolFullName(toolName);
  return [
    `${fullName} requires a selected capability for this agent.`,
    `Ask a configured DM or conversation approver to approve request_permission with permissionKind=tool, toolName=${fullName}, temporaryOnly=false, then choose Always allow.`,
    `Admins can also grant tool id tool:${fullName} through settings.yaml or the control API.`,
  ].join(' ');
}
