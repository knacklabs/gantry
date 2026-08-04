import { ensureAgentCredentialBinding as ensureApplicationAgentCredentialBinding, ensureModelCredentialBinding as ensureApplicationModelCredentialBinding, } from '../../application/credentials/agent-credential-service.js';
import { GantryModelGatewayBroker } from '../llm/anthropic-claude-agent/gantry-model-gateway.js';
export async function createAgentCredentialBroker(options) {
    if (options.broker)
        return options.broker;
    if (options.mode !== 'gantry')
        return undefined;
    if (!options.modelCredentials) {
        throw new Error('Gantry Model Gateway requires a model credential repository.');
    }
    return new GantryModelGatewayBroker(options.modelCredentials, {
        bindHost: options.gatewayBindHost,
        audit: options.publishRuntimeEvent,
        ...(options.limits ? { limits: options.limits } : {}),
    });
}
export async function ensureModelCredentialBinding(input) {
    const broker = await createAgentCredentialBroker({
        mode: input.mode,
        broker: input.broker,
        modelCredentials: input.modelCredentials,
        gatewayBindHost: input.gatewayBindHost,
        publishRuntimeEvent: input.publishRuntimeEvent,
    });
    return ensureApplicationModelCredentialBinding({
        mode: input.mode,
        broker,
    });
}
export async function ensureAgentCredentialBinding(input) {
    const broker = await createAgentCredentialBroker({
        mode: input.mode,
        broker: input.broker,
        modelCredentials: input.modelCredentials,
        gatewayBindHost: input.gatewayBindHost,
        publishRuntimeEvent: input.publishRuntimeEvent,
    });
    return ensureApplicationAgentCredentialBinding({
        mode: input.mode,
        broker,
        name: input.name,
        identifier: input.identifier,
    });
}
