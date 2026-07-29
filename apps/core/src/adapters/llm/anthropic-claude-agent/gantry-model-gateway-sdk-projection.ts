import {
  listExecutableModelProviders,
  type ModelProviderDefinition,
} from '../../../shared/model-provider-registry.js';

export function projectGatewayTokenEnv(input: {
  provider: ModelProviderDefinition;
  baseUrl: string;
  token: string;
}): Record<string, string> {
  const projection = input.provider.gateway.sdkProjection;
  return {
    [projection.baseUrlEnv]: input.baseUrl,
    [projection.tokenEnv]: input.token,
    ...(projection.additionalTokenEnv
      ? { [projection.additionalTokenEnv]: input.token }
      : {}),
  };
}
export function projectedModelCredentialEnvKeys(): string[] {
  return [
    ...new Set([
      ...listExecutableModelProviders().flatMap((provider) => {
        const projection = provider.gateway.sdkProjection;
        return [
          projection.baseUrlEnv,
          projection.tokenEnv,
          projection.additionalTokenEnv,
        ].filter((key): key is string => Boolean(key));
      }),
    ]),
  ].sort();
}
