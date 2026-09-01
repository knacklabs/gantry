import { submitTaskLifecycleDataRequest } from './mcp/tools/task-lifecycle.js';

export type CompletionGateConfig = {
  toolName: string;
  maxNoProgressContinuations: number;
  interactionTimeoutMs: number;
};

type Decision =
  | { decision: 'accept'; progressToken: string }
  | { decision: 'continue'; progressToken: string; message: string };

export class CompletionGate {
  private completionAttempt = 0;
  private lastProgressToken: string | undefined;
  private consecutiveNoProgress = 0;

  constructor(private readonly config: CompletionGateConfig) {}

  async check(proposedResult: string | null): Promise<Decision> {
    this.completionAttempt += 1;
    const response = await submitTaskLifecycleDataRequest({
      type: 'caller_resolved_tool',
      payload: {
        toolName: this.config.toolName,
        toolInput: {
          completionAttempt: this.completionAttempt,
          proposedResult: parseProposedResult(proposedResult),
        },
      },
      responseTimeoutMs: this.config.interactionTimeoutMs + 5_000,
    });
    if (!response?.ok) {
      throw new Error(
        response?.error ?? response?.message ?? 'Completion gate failed.',
      );
    }
    const decision = parseDecision(response.data);
    if (decision.decision === 'accept') return decision;
    if (decision.progressToken === this.lastProgressToken) {
      this.consecutiveNoProgress += 1;
    } else {
      this.lastProgressToken = decision.progressToken;
      this.consecutiveNoProgress = 0;
    }
    if (this.consecutiveNoProgress >= this.config.maxNoProgressContinuations) {
      throw new Error(
        'Completion gate stopped after repeated continuations without progress.',
      );
    }
    return decision;
  }
}

function parseProposedResult(value: string | null): unknown {
  if (!value?.trim()) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseDecision(value: unknown): Decision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Completion gate returned an invalid decision.');
  }
  const row = value as Record<string, unknown>;
  const progressToken =
    typeof row.progressToken === 'string' ? row.progressToken.trim() : '';
  if (!progressToken) {
    throw new Error('Completion gate is missing progressToken.');
  }
  if (row.decision === 'accept') return { decision: 'accept', progressToken };
  const message = typeof row.message === 'string' ? row.message.trim() : '';
  if (row.decision === 'continue' && message) {
    return { decision: 'continue', progressToken, message };
  }
  throw new Error('Completion gate returned an invalid decision.');
}
