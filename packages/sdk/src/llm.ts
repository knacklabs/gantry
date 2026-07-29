import type * as OpenApi from './openapi-types.js';
import type {
  LlmRequestOptions,
  RequestOptions,
  TransportResponse,
} from './types.js';
import type { GantryError } from './transport.js';

type LlmTransport = {
  requestWithMetadata<T>(
    options: RequestOptions,
  ): Promise<TransportResponse<T>>;
};

export function createLlmClient(transport: LlmTransport) {
  return {
    chatCompletions: (
      input: OpenApi.LlmChatCompletionsRequest,
      options?: LlmRequestOptions,
    ) =>
      transport
        .requestWithMetadata<OpenApi.LlmChatCompletionsResponse>({
          method: 'POST',
          path: '/llm/v1/chat/completions',
          body: input,
          traceparent: options?.traceparent,
        })
        .then(({ body, headers }) => ({
          response: body,
          gantryRequestId: requiredHeader(headers, 'x-gantry-request-id'),
          modelAlias: requiredHeader(headers, 'x-gantry-model-alias'),
          modelRoute: requiredHeader(headers, 'x-gantry-model-route'),
          provider: requiredHeader(headers, 'x-gantry-provider'),
        })),
  };
}

function requiredHeader(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = headers[name]?.trim();
  if (value) return value;
  const error = new Error(`Gantry response is missing ${name}`) as GantryError;
  error.code = 'INVALID_RESPONSE';
  throw error;
}
