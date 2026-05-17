import path from 'node:path';

import { memoryAgentIdForGroupFolder } from '../memory/app-memory-boundaries.js';
import type { TaskContext } from './ipc-types.js';
import {
  adminMcpToolFullName,
  adminMcpToolIdForFullName,
  type AdminMcpToolName,
} from '../shared/admin-mcp-tools.js';
import { readLiveToolRules } from '../shared/live-tool-rules.js';

export async function sourceAgentHasAdminToolCapability(
  context: Pick<
    TaskContext,
    'data' | 'deps' | 'sourceAgentFolder' | 'ipcBaseDir'
  >,
  toolName: AdminMcpToolName,
): Promise<boolean> {
  if (!context.data.appId) return false;
  const fullName = adminMcpToolFullName(toolName);
  if (sourceAgentHasLiveAdminToolRule(context, fullName)) return true;

  const repository = context.deps.getToolRepository?.();
  if (!repository) return false;
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

function sourceAgentHasLiveAdminToolRule(
  context: Pick<TaskContext, 'data' | 'sourceAgentFolder' | 'ipcBaseDir'>,
  fullName: string,
): boolean {
  return readLiveToolRules({
    ipcDir: context.ipcBaseDir
      ? path.join(context.ipcBaseDir, context.sourceAgentFolder)
      : undefined,
    runHandle: context.data.runHandle,
  }).includes(fullName);
}

export function adminCapabilityRequiredMessage(
  toolName: AdminMcpToolName,
): string {
  const fullName = adminMcpToolFullName(toolName);
  return [
    `${fullName} requires a selected capability for this agent.`,
    `Ask a configured conversation approver to approve ${fullName}, then choose Always allow.`,
    `Admins can also grant tool id tool:${fullName} through settings.yaml or the control API.`,
  ].join(' ');
}
