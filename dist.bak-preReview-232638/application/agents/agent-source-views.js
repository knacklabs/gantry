export async function readableSkillSources(input) {
    const activeBindings = input.skillBindings.filter((binding) => binding.status === 'active');
    const skills = await Promise.all(activeBindings.map((binding) => input.repository.getSkill(binding.skillId)));
    return activeBindings.map((binding, index) => {
        const skill = skills[index];
        return {
            ...(skill ? { name: skill.name } : {}),
            id: String(binding.skillId),
        };
    });
}
export function readableToolSources(sources) {
    return sources
        .filter((source) => source.status === 'active')
        .map((source) => ({
        id: source.sourceId,
        kind: source.kind,
        ...(source.version && source.version !== source.kind
            ? { version: source.version }
            : {}),
    }));
}
export function buildAgentSources(input) {
    return {
        skills: input.configuredSkillSources,
        mcpServers: input.mcpBindings
            .filter((binding) => binding.status === 'active')
            .map((binding) => ({
            id: String(binding.serverId),
            ...(binding.allowedToolPatterns?.length
                ? { tools: [...binding.allowedToolPatterns] }
                : {}),
        })),
        tools: readableToolSources(input.toolSources),
    };
}
