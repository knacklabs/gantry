export function normalizeSchedulerAccessRequirements(input) {
    return input?.map((requirement) => {
        const target = requirement.target;
        if (target.kind === 'tool_rule') {
            return {
                target: { kind: 'tool_rule', rule: target.rule },
                ...(requirement.reason ? { reason: requirement.reason } : {}),
            };
        }
        if (target.kind === 'mcp_server') {
            return {
                target: { kind: 'mcp_server', server: target.server },
                ...(requirement.reason ? { reason: requirement.reason } : {}),
            };
        }
        return {
            target: {
                kind: 'capability',
                capabilityId: target.capability_id,
                ...(target.implementation
                    ? {
                        implementation: {
                            kind: target.implementation.kind,
                            name: target.implementation.name,
                            executablePath: target.implementation.executable_path,
                            executableVersion: target.implementation.executable_version,
                            executableHash: target.implementation.executable_hash,
                            commandTemplate: target.implementation.command_template,
                            authPreflight: target.implementation.auth_preflight,
                            protectedPaths: target.implementation.protected_paths,
                            networkHosts: target.implementation.network_hosts,
                        },
                    }
                    : {}),
            },
            ...(requirement.reason ? { reason: requirement.reason } : {}),
        };
    });
}
