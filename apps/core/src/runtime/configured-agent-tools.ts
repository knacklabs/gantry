import type { ToolCatalogRepository } from '../domain/ports/repositories.js';

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
  const activeBindings = bindings.filter(
    (binding) => binding.status === 'active',
  );
  const tools = await Promise.all(
    activeBindings.map((binding) => input.repository?.getTool(binding.toolId)),
  );
  return tools.flatMap((tool) => {
    const name = tool?.name?.trim();
    return name ? [name] : [];
  });
}
