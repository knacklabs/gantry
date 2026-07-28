import { submitTaskLifecycleDataRequest } from './mcp/tools/task-lifecycle.js';

export type DelegatedCompletionGateConfig = {
  toolName: string;
  maxNoProgressContinuations: number;
  interactionTimeoutMs: number;
};

export type DelegatedCompletionDecision =
  | { decision: 'accept'; progressToken: string }
  | { decision: 'continue'; progressToken: string; message: string };

export class DelegatedCompletionGate {
  private completionAttempt = 0;
  private lastProgressToken: string | undefined;
  private consecutiveNoProgress = 0;

  constructor(private readonly config: DelegatedCompletionGateConfig) {}

  async check(): Promise<DelegatedCompletionDecision> {
    this.completionAttempt += 1;
    const response = await submitTaskLifecycleDataRequest({
      type: 'caller_resolved_tool',
      payload: {
        toolName: this.config.toolName,
        toolInput: { completionAttempt: this.completionAttempt },
      },
      responseTimeoutMs: this.config.interactionTimeoutMs + 5_000,
    });
    if (!response) {
      throw new Error('Delegated completion gate timed out.');
    }
    if (!response.ok) {
      throw new Error(
        response.error ??
          response.message ??
          'Delegated completion gate was rejected.',
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
        `Delegated completion gate stopped after ${this.consecutiveNoProgress} consecutive continuations without progress.`,
      );
    }
    return decision;
  }
}

function parseDecision(value: unknown): DelegatedCompletionDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Delegated completion gate returned an invalid decision.');
  }
  const row = value as Record<string, unknown>;
  const progressToken =
    typeof row.progressToken === 'string' ? row.progressToken.trim() : '';
  if (!progressToken) {
    throw new Error(
      'Delegated completion gate decision is missing progressToken.',
    );
  }
  if (row.decision === 'accept') {
    return { decision: 'accept', progressToken };
  }
  const message = typeof row.message === 'string' ? row.message.trim() : '';
  if (row.decision === 'continue' && message) {
    return { decision: 'continue', progressToken, message };
  }
  throw new Error('Delegated completion gate returned an invalid decision.');
}
