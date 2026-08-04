import type { AgentOutput } from './agent-spawn-types.js';

export function providerSessionExternalSessionId(
  output: Pick<AgentOutput, 'providerSession' | 'newSessionId'>,
): string | undefined {
  return (
    output.providerSession?.externalSessionId?.trim() ||
    output.newSessionId?.trim() ||
    undefined
  );
}

export function outputWithProviderSession(
  output: AgentOutput,
  externalSessionId: string | undefined,
): AgentOutput {
  const resolved =
    externalSessionId ?? providerSessionExternalSessionId(output);
  if (!resolved) return output;
  return {
    ...output,
    providerSession: { externalSessionId: resolved },
    newSessionId: output.newSessionId ?? resolved,
  };
}

export function runnerResultWithProviderSession(input: {
  status: AgentOutput['status'];
  externalSessionId: string | undefined;
  error?: string;
}): AgentOutput {
  return outputWithProviderSession(
    {
      status: input.status,
      result: null,
      ...(input.error ? { error: input.error } : {}),
    },
    input.externalSessionId,
  );
}
