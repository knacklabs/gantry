import { listExecutableModelProviders, } from '../../../shared/model-provider-registry.js';
export function projectGatewayTokenEnv(input) {
    const projection = input.provider.gateway.sdkProjection;
    return {
        [projection.baseUrlEnv]: input.baseUrl,
        [projection.tokenEnv]: input.token,
        ...(projection.additionalTokenEnv
            ? { [projection.additionalTokenEnv]: input.token }
            : {}),
    };
}
export function projectedModelCredentialEnvKeys() {
    return [
        ...new Set([
            ...listExecutableModelProviders().flatMap((provider) => {
                const projection = provider.gateway.sdkProjection;
                return [
                    projection.baseUrlEnv,
                    projection.tokenEnv,
                    projection.additionalTokenEnv,
                ].filter((key) => Boolean(key));
            }),
        ]),
    ].sort();
}
