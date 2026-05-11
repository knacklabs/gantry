import { memoryAgentIdForGroupFolder } from '../memory/app-memory-boundaries.js';
import type { TaskContext } from './ipc-types.js';
import {
  adminMcpToolFullName,
  adminMcpToolIdForFullName,
  type AdminMcpToolName,
} from '../shared/admin-mcp-tools.js';

export async function sourceAgentHasAdminToolCapability(
  context: Pick<TaskContext, 'data' | 'deps' | 'sourceAgentFolder'>,
  toolName: AdminMcpToolName,
): Promise<boolean> {
  const repository = context.deps.getToolRepository?.();
  if (!repository || !context.data.appId) return false;
  const fullName = adminMcpToolFullName(toolName);
  const toolId = adminMcpToolIdForFullName(fullName);
  const bindings = await repository.listAgentToolBindings({
    appId: context.data.appId as never,
    agentId: memoryAgentIdForGroupFolder(context.sourceAgentFolder) as never,
  });
  const hasActiveBinding = bindings.some(
    (binding) =>
      binding.status === 'active' && String(binding.toolId) === toolId,
  );
  if (!hasActiveBinding) return false;
  const tool = await repository.getTool(toolId as never);
  return (
    tool?.appId === context.data.appId &&
    tool.status === 'active' &&
    tool.selectable === true
  );
}

export function adminCapabilityRequiredMessage(
  toolName: AdminMcpToolName,
): string {
  const fullName = adminMcpToolFullName(toolName);
  return [
    `${fullName} requires a selected capability for this agent.`,
    `Ask a configured conversation approver to approve request_permission with permissionKind=tool, toolName=${fullName}, temporaryOnly=false, then choose Always allow.`,
    `Admins can also grant tool id tool:${fullName} through settings.yaml or the control API.`,
  ].join(' ');
}
