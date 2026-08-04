import { CapabilitySecretService } from './capability-secret-service.js';
export async function resolveMcpCredentialEnvForAgent(input) {
    const records = await input.mcpServers.listMaterializedServersForAgent({
        appId: input.appId,
        agentId: input.agentId,
        ...(input.serverIds ? { serverIds: input.serverIds } : {}),
    });
    const service = new CapabilitySecretService(input.secrets);
    const credentialEnv = {};
    for (const record of records) {
        const refs = record.definition.credentialRefs;
        if (refs.length === 0)
            continue;
        const resolved = await service.resolveMcpCredentialRefs({
            appId: input.appId,
            refs,
            allowedCapabilityIds: [
                record.definition.id,
                `mcp:${record.definition.name}`,
            ],
        });
        Object.assign(credentialEnv, resolved.credentialEnv);
    }
    return credentialEnv;
}
