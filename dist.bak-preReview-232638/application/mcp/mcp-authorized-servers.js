// Discovery is not authorization: every ACTIVE bound MCP server is a projected
// source (inventory-only connects included), regardless of which mcp__ tool
// rules are selected. Action stays capability-gated at call time by the
// reviewed pattern/name checks in mcp-tool-authorization.
export async function authorizedMcpServerIdsForAgent(input) {
    const bindings = await input.mcpServers.listAgentBindings({
        appId: input.appId,
        agentId: input.agentId,
        limit: 500,
    });
    const activeBindings = bindings.filter((binding) => binding.status === 'active');
    const servers = await Promise.all(activeBindings.map((binding) => input.mcpServers.getServer(binding.serverId)));
    return activeBindings.flatMap((binding, index) => {
        const server = servers[index];
        if (!server || server.appId !== input.appId)
            return [];
        return [String(binding.serverId)];
    });
}
