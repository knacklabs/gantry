import { getModelProviderDefinition } from '../../../shared/model-provider-registry.js';
export function validateModelCredentialProjectionForEntry(input) {
    const { model, projection } = input;
    const isGantryGatewayProjection = projection.brokerProfile === 'gantry';
    if (!isGantryGatewayProjection) {
        throw new Error(`Model ${model.displayName} requires Gantry Model Gateway credentials from Model Access. Run \`gantry credentials model set ${model.modelRoute.id}\`.`);
    }
    validateGantryGatewayProjection(projection.env, model);
}
function validateGantryGatewayProjection(env, model) {
    // The gateway projects provider-specific env names (ANTHROPIC_* for the
    // Anthropic route, OPENAI_* for OpenAI-compatible routes); validate the
    // names the model's provider actually declares.
    const projection = getModelProviderDefinition(model.modelRoute.id)?.gateway
        .sdkProjection;
    const baseUrlEnv = projection?.baseUrlEnv ?? 'ANTHROPIC_BASE_URL';
    const tokenEnv = projection?.tokenEnv ?? 'ANTHROPIC_API_KEY';
    if (env.CLAUDE_CODE_OAUTH_TOKEN) {
        throw new Error(`Gantry Model Gateway projection for ${model.displayName} must not expose provider OAuth tokens.`);
    }
    if (!isLoopbackGatewayUrl(env[baseUrlEnv])) {
        throw new Error(`Gantry Model Gateway projection for ${model.displayName} must use a loopback ${baseUrlEnv}.`);
    }
    if (!env[tokenEnv]?.startsWith('gtw_')) {
        throw new Error(`Gantry Model Gateway projection for ${model.displayName} must use a run-scoped gateway token.`);
    }
    if (env.ANTHROPIC_AUTH_TOKEN &&
        !env.ANTHROPIC_AUTH_TOKEN.startsWith('gtw_')) {
        throw new Error(`Gantry Model Gateway projection for ${model.displayName} must not expose provider auth tokens.`);
    }
}
function isLoopbackGatewayUrl(value) {
    if (!value)
        return false;
    try {
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase();
        return (url.protocol === 'http:' &&
            (hostname === '127.0.0.1' ||
                hostname === 'localhost' ||
                hostname === '::1' ||
                hostname === '[::1]'));
    }
    catch {
        return false;
    }
}
