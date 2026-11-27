import { requireSourceModelSnapshot } from '../../../shared/source-model-snapshot.js';
import { randomUUID } from 'node:crypto';
import type { MemoryLlmQueryOpts } from '../../../domain/ports/memory-llm-client.js';
import type { AgentRunId } from '../../../domain/events/events.js';
import { resolveModelSelectionForWorkload } from '../../../shared/model-catalog.js';
import { getModelProviderDefinition } from '../../../shared/model-provider-registry.js';
import { resolveGatewayMemoryInjection } from '../openai-memory/memory-gateway-injection.js';
import { runWithMemoryOperationTimeout } from '../../../shared/memory-dreaming-timeout.js';
/** Uses the provider's count-only endpoint. It does not generate model output. */
export async function countAnthropicSourceTokens(
  opts: MemoryLlmQueryOpts,
): Promise<number> {
  const selected = opts.modelProfile?.sourceModelSnapshot
    ? {
        ok: true as const,
        entry: requireSourceModelSnapshot(opts.modelProfile.sourceModelSnapshot)
          .entry,
      }
    : resolveModelSelectionForWorkload(
        opts.modelProfile?.alias ?? opts.model,
        'chat',
      );
  if (!selected.ok || selected.entry.responseFamily !== 'anthropic')
    throw new Error('Source token counting requires an Anthropic model route');
  const provider = getModelProviderDefinition(selected.entry.modelRoute.id);
  if (!provider) throw new Error('Source token counting route absent');
  return runWithMemoryOperationTimeout(
    async (signal) => {
      const gateway = await resolveGatewayMemoryInjection({
        appId: opts.appId,
        modelRouteId: selected.entry.modelRoute.id,
        runId: `source-token-count:${randomUUID()}` as AgentRunId,
      });
      try {
        const projection = provider.gateway.sdkProjection;
        const baseUrl = gateway.injection.env[projection.baseUrlEnv];
        const token = gateway.injection.env[projection.tokenEnv];
        if (!baseUrl || !token?.startsWith('gtw_'))
          throw new Error(
            'Source token count requires run-scoped native gateway authority',
          );
        const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: selected.entry.runnerModel,
            messages: [{ role: 'user', content: opts.prompt }],
          }),
          signal,
        });
        if (!response.ok)
          throw new Error(`Source token count failed (${response.status})`);
        const result = (await response.json()) as { input_tokens?: unknown };
        if (
          typeof result.input_tokens !== 'number' ||
          !Number.isSafeInteger(result.input_tokens) ||
          result.input_tokens < 0
        )
          throw new Error('Source token count response invalid');
        return result.input_tokens;
      } finally {
        await gateway.revoke();
      }
    },
    {
      timeoutMs: Math.min(opts.timeoutMs ?? 15000, 15000),
      parentSignal: opts.signal,
      label: 'source conversation token count',
    },
  );
}
