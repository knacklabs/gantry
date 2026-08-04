export function withStdioMcpEgressEnv(capabilities, toolNetworkEnv) {
    const sanitizedToolNetworkEnv = Object.fromEntries(Object.entries(toolNetworkEnv).filter((entry) => typeof entry[1] === 'string' && entry[1].length > 0));
    return capabilities.map((capability) => {
        if (capability.config.type !== 'stdio')
            return capability;
        return {
            ...capability,
            config: {
                ...capability.config,
                env: {
                    ...(capability.config.env ?? {}),
                    ...sanitizedToolNetworkEnv,
                },
            },
        };
    });
}
