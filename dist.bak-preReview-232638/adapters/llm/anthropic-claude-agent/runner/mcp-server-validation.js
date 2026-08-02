import fs from 'node:fs';
import { isHostPrivateBrowserMcpServerName } from '../../../../shared/agent-tool-references.js';
let externalMcpServerEgressEnv = {};
const TERMINAL_MCP_SERVER_FAILURE_STATUSES = new Set([
    'failed',
    'needs-auth',
    'disabled',
]);
export function readExternalMcpServers() {
    const configPath = process.env.GANTRY_MCP_CONFIG_FILE?.trim();
    if (configPath) {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        fs.rmSync(configPath, { force: true });
        return validateExternalMcpServers(withExternalMcpServerEgressEnv(parsed));
    }
    const raw = process.env.GANTRY_MCP_SERVERS_JSON?.trim();
    if (!raw)
        return {};
    const parsed = JSON.parse(raw);
    return validateExternalMcpServers(withExternalMcpServerEgressEnv(parsed));
}
export function setExternalMcpServerEgressEnv(toolNetworkEnv) {
    externalMcpServerEgressEnv = Object.fromEntries(Object.entries(toolNetworkEnv).filter((entry) => typeof entry[1] === 'string' && entry[1].length > 0));
}
function withExternalMcpServerEgressEnv(parsed) {
    return Object.fromEntries(Object.entries(parsed).map(([name, config]) => {
        if (config.type === 'http' || config.type === 'sse') {
            return [name, config];
        }
        const stdioConfig = config;
        return [
            name,
            {
                ...stdioConfig,
                env: {
                    ...(stdioConfig.env ?? {}),
                    ...externalMcpServerEgressEnv,
                },
            },
        ];
    }));
}
export function assertRequiredMcpServerReady(message) {
    const initMessage = message;
    if (!Array.isArray(initMessage.mcp_servers)) {
        throw new Error('Required Gantry MCP server status is missing from Claude init');
    }
    const gantryServer = initMessage.mcp_servers.find((server) => server.name === 'gantry');
    if (!gantryServer) {
        throw new Error('Required Gantry MCP server is missing from Claude init');
    }
    const status = String(gantryServer.status ?? '').toLowerCase();
    // Claude emits init once and may snapshot an alwaysLoad stdio server before
    // its handshake completes. The SDK's timeout gates turn-one availability, so
    // polling here would duplicate that wait; only known terminal states fail.
    if (TERMINAL_MCP_SERVER_FAILURE_STATUSES.has(status)) {
        throw new Error(`Required Gantry MCP server is not ready: ${status}`);
    }
}
function validateExternalMcpServers(parsed) {
    const servers = {};
    for (const [name, config] of Object.entries(parsed)) {
        if (name === 'gantry') {
            throw new Error('Configured MCP servers cannot override the built-in gantry server');
        }
        if (isHostPrivateBrowserServerName(name)) {
            throw new Error('Host-private browser MCP servers are not configurable. Use the canonical Browser capability and Gantry-owned browser gateway tools.');
        }
        servers[name] = config;
    }
    return servers;
}
const isHostPrivateBrowserServerName = isHostPrivateBrowserMcpServerName;
