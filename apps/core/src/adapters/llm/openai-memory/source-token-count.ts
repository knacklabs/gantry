import { requireSourceModelSnapshot } from '../../../shared/source-model-snapshot.js';
import { randomUUID } from 'node:crypto';
import type { MemoryLlmQueryOpts } from '../../../domain/ports/memory-llm-client.js';
import type { AgentRunId } from '../../../domain/events/events.js';
import { resolveModelSelectionForWorkload } from '../../../shared/model-catalog.js';
import { getModelProviderDefinition } from '../../../shared/model-provider-registry.js';
import { resolveGatewayMemoryInjection } from './memory-gateway-injection.js';
import { runWithMemoryOperationTimeout } from '../../../shared/memory-dreaming-timeout.js';
/** Provider-authoritative Responses input count. It does not generate text. */
export async function countOpenAiSourceTokens(
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
  if (!selected.ok || selected.entry.modelRoute.id !== 'openai')
    throw new Error('Source token count requires the OpenAI route');
  const provider = getModelProviderDefinition('openai')!;
  return runWithMemoryOperationTimeout(
    async (signal) => {
      const gateway = await resolveGatewayMemoryInjection({
        appId: opts.appId,
        modelRouteId: 'openai',
        runId: `source-token-count:${randomUUID()}` as AgentRunId,
      });
      try {
        const base =
          gateway.injection.env[provider.gateway.sdkProjection.baseUrlEnv];
        const token =
          gateway.injection.env[provider.gateway.sdkProjection.tokenEnv];
        if (!base || !token?.startsWith('gtw_'))
          throw new Error('Source count requires native gateway authority');
        const response = await fetch(`${base}/v1/responses/input_tokens`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: selected.entry.runnerModel,
            input: opts.prompt,
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
