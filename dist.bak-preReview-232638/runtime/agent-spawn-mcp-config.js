import fs from 'fs';
import path from 'path';
export function writeRunnerMcpConfigFile(workspaceIpcDir, capabilities) {
    const configPath = path.join(workspaceIpcDir, `mcp-${globalThis.crypto.randomUUID()}.json`);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(Object.fromEntries(capabilities.map((capability) => [capability.name, capability.config]))), { encoding: 'utf-8', mode: 0o600 });
    return configPath;
}
