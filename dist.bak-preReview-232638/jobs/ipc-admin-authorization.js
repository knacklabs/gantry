import path from 'node:path';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { adminMcpToolFullName, adminMcpToolIdForFullName, } from '../shared/admin-mcp-tools.js';
import { readLiveToolRules } from '../shared/live-tool-rules.js';
export async function sourceAgentHasAdminToolCapability(context, toolName) {
    if (!context.data.appId)
        return false;
    const fullName = adminMcpToolFullName(toolName);
    if (sourceAgentHasLiveAdminToolRule(context, fullName))
        return true;
    const repository = context.deps.getToolRepository?.();
    if (!repository)
        return false;
    const toolId = adminMcpToolIdForFullName(fullName);
    const bindings = await repository.listAgentToolBindings({
        appId: context.data.appId,
        agentId: memoryAgentIdForWorkspaceFolder(context.sourceAgentFolder),
    });
    const hasActiveBinding = bindings.some((binding) => binding.status === 'active' && String(binding.toolId) === toolId);
    if (!hasActiveBinding)
        return false;
    const tool = await repository.getTool(toolId);
    return (tool?.appId === context.data.appId &&
        tool.status === 'active' &&
        tool.selectable === true);
}
function sourceAgentHasLiveAdminToolRule(context, fullName) {
    return readLiveToolRules({
        ipcDir: context.ipcBaseDir
            ? path.join(context.ipcBaseDir, context.sourceAgentFolder)
            : undefined,
        runHandle: context.data.runHandle,
    }).includes(fullName);
}
export function adminCapabilityRequiredMessage(toolName) {
    const fullName = adminMcpToolFullName(toolName);
    return [
        `${fullName} requires a selected capability for this agent.`,
        `Ask a configured conversation approver to approve ${toolName}, then choose persistent access.`,
        'Admins can also select this exact admin capability through settings.yaml or the control API.',
    ].join(' ');
}
