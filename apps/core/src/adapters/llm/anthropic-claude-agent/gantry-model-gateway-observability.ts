import type { NormalizedModelUsage } from '../../../shared/model-catalog.js';
import {
  observeGatewayCall,
  type GatewayCallObservation,
  type GatewayCallTokenContext,
  type GatewayStreamTap,
} from '../observability/genai-spans.js';
import { contentCaptureEnabled } from '../../../infrastructure/observability/tracing.js';

// Observability glue for the gateway hot path. Every helper is fail-open:
// tracing must never affect the proxied request or response.

export function beginGatewayObservation(input: {
  token: GatewayCallTokenContext;
  providerId: string;
  upstreamUrl: URL;
  body: Buffer;
}): { observation: GatewayCallObservation | undefined; requestBody: Buffer } {
  if (isBatchTransportPath(input.providerId, input.upstreamUrl.pathname)) {
    return { observation: undefined, requestBody: input.body };
  }
  const observation = observeGatewayCall({
    token: input.token,
    providerId: input.providerId,
    upstreamUrl: input.upstreamUrl,
    requestBody: input.body,
  });
  return { observation, requestBody: observation?.requestBody ?? input.body };
}

function isBatchTransportPath(providerId: string, pathname: string): boolean {
  if (providerId === 'openai') {
    return /^\/v1\/(?:batches|files)(?:\/|$)/.test(pathname);
  }
  return (
    providerId === 'anthropic' &&
    /^\/v1\/messages\/batches(?:\/|$)/.test(pathname)
  );
}

// Upstream call never produced a response (auth injection or fetch threw):
// end the span as a 502 so timeouts/network failures still export a trace.
export function failGatewayObservation(
  observation: GatewayCallObservation | undefined,
  error: unknown,
): void {
  // Credential-resolution failures can name secret references; only export
  // the raw message under content capture.
  const raw = error instanceof Error ? error.message : String(error);
  observation?.finish({
    status: 502,
    errorMessage: contentCaptureEnabled()
      ? raw.slice(0, 256)
      : 'gateway request failed',
  });
}

export function finishGatewayNonStreaming(
  observation: GatewayCallObservation | undefined,
  status: number,
  response: Response,
  responseJson: unknown,
  normalizedUsage: NormalizedModelUsage | undefined,
): void {
  if (!observation || observation.isStreaming) return;
  // responseJson is the gateway's single shared clone+parse (OK bodies only —
  // a 4xx/5xx upstream that stalls after headers must not hang the proxy).
  if (!response.ok) {
    // statusText is upstream-controlled; only export it when content
    // capture is on (bounded to a reason-phrase-sized slice).
    observation.finish({
      status,
      errorMessage: contentCaptureEnabled()
        ? response.statusText.slice(0, 256) || undefined
        : 'upstream error',
    });
    return;
  }
  observation.finish({ status, responseJson, normalizedUsage });
}

export function resolveGatewayTap(
  observation: GatewayCallObservation | undefined,
  response: Response,
): GatewayStreamTap | undefined {
  try {
    return observation?.isStreaming
      ? observation.streamTapFor(
          response.headers.get('content-type'),
          response.status,
        )
      : undefined;
  } catch {
    return undefined;
  }
}
