import { tool } from '@langchain/core/tools';
import { evaluateNeutralToolPreChecks, } from '../../../../runner/tool-gate-core.js';
import { requestPermissionApprovalViaIpc, } from '../../../../runner/permission-ipc-client.js';
export function wrapThirdPartyMcpToolsWithGate(tools, serverName, config) {
    return tools.map((underlying) => wrapOne(underlying, serverName, config));
}
function wrapOne(underlying, serverName, config) {
    const gatedFunc = async (input) => {
        const toolName = canonicalThirdPartyMcpToolName(serverName, underlying.name);
        const preChecks = evaluateNeutralToolPreChecks({
            toolName,
            toolInput: input,
            memoryBlock: config.memoryBlock,
            // The model sees the raw MCP name, while the gate uses the canonical
            // mcp__server__tool name. Keep the explicit MCP signal as defense in depth.
            isThirdPartyMcpTool: true,
            yoloMode: config.gateContext.yoloMode,
        });
        if (preChecks) {
            return denyMessage(preChecks.reason);
        }
        const approval = await requestPermissionApprovalViaIpc(config.permissionEnv, {
            appId: config.permissionEnv.appId,
            agentId: config.permissionEnv.agentId || undefined,
            agentFolder: config.workspaceFolder,
            targetJid: config.permissionEnv.chatJid || undefined,
            toolName,
            toolInput: input,
            threadId: config.gateContext.threadId,
            ...(config.signal ? { signal: config.signal } : {}),
        });
        if (approval.approved) {
            return invokeUnderlying(underlying, input);
        }
        const reason = approval.reason || 'Denied by operator';
        return denyMessage(`Permission denied: ${reason}`);
    };
    return tool(gatedFunc, {
        name: underlying.name,
        description: underlying.description,
        // @langchain/core tool() accepts the underlying zod/JSON schema directly.
        schema: underlying.schema,
    });
}
async function invokeUnderlying(underlying, input) {
    return underlying.invoke(input);
}
export function canonicalThirdPartyMcpToolName(serverName, toolName) {
    return `mcp__${serverName}__${toolName}`;
}
export function gatedToolErrorResult(message, category = 'permission') {
    return {
        content: [{ type: 'text', text: message }],
        isError: true,
        error: { category, isRetryable: false, message },
    };
}
function denyMessage(reason) {
    return gatedToolErrorResult(reason);
}
