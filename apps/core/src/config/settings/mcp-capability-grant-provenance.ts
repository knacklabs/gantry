import type {
  RuntimeConfiguredAgentCapability,
  RuntimeSettings,
} from './runtime-settings-types.js';

export function mcpCapabilityGrantTokenKey(
  agentFolder: string,
  capability: RuntimeConfiguredAgentCapability,
): string {
  return JSON.stringify([agentFolder, capability.id, capability.version]);
}

export function nextMcpCapabilityGrantTokens(input: {
  settings: RuntimeSettings;
  previous?: Readonly<Record<string, string>>;
  overrides?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const selectedKeys = new Set(
    Object.entries(input.settings.agents).flatMap(([folder, agent]) =>
      agent.capabilities.map((capability) =>
        mcpCapabilityGrantTokenKey(folder, capability),
      ),
    ),
  );
  return Object.fromEntries(
    Object.entries({ ...input.previous, ...input.overrides })
      .filter(([key]) => selectedKeys.has(key))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}
