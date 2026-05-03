import type { ToolCatalogRepository } from '../domain/ports/repositories.js';

function configuredAllowedToolName(toolId: unknown): string {
  const value = String(toolId);
  return value.startsWith('tool:') ? value.slice('tool:'.length) : value;
}

export async function resolveConfiguredAllowedTools(input: {
  repository?: ToolCatalogRepository;
  appId: string;
  agentId: string;
}): Promise<string[] | undefined> {
  if (!input.repository) return undefined;
  const bindings = await input.repository.listAgentToolBindings({
    appId: input.appId as never,
    agentId: input.agentId as never,
  });
  return bindings
    .filter((binding) => binding.status === 'active')
    .map((binding) => configuredAllowedToolName(binding.toolId));
}
