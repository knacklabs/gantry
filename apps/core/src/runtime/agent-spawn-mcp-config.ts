import fs from 'fs';
import path from 'path';

import type { MaterializedMcpCapability } from '../application/mcp/mcp-server-service.js';

function resolveCommandFromPath(command: string): string {
  if (
    path.isAbsolute(command) ||
    command.includes('/') ||
    command.includes('\\')
  )
    return command;
  const searchDirectories = [
    path.join(process.cwd(), 'node_modules', '.bin'),
    ...(process.env.PATH ?? '').split(path.delimiter),
  ];
  for (const directory of searchDirectories) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return command;
}

export function writeRunnerMcpConfigFile(
  workspaceIpcDir: string,
  capabilities: MaterializedMcpCapability[],
): string {
  const configPath = path.join(
    workspaceIpcDir,
    `mcp-${globalThis.crypto.randomUUID()}.json`,
  );
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      Object.fromEntries(
        capabilities.map((capability) => [
          capability.name,
          'command' in capability.config
            ? {
                ...capability.config,
                command: resolveCommandFromPath(capability.config.command),
              }
            : capability.config,
        ]),
      ),
    ),
    { encoding: 'utf-8', mode: 0o600 },
  );
  return configPath;
}
