export interface AgentCommandContext {
  conversationId: string;
  conversationJid: string;
  threadId: string | null;
}

export type AgentCommandVisibility = 'operator' | 'customer';

export interface AgentCommandModule {
  name: string;
  description: string;
  visibility: AgentCommandVisibility;
  timeoutMs?: number;
  ackOnStart?: string;
  run(ctx: AgentCommandContext): Promise<string>;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

export function isAgentCommandModule(
  value: unknown,
): value is AgentCommandModule {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.name === 'string' &&
    typeof c.description === 'string' &&
    (c.visibility === 'operator' || c.visibility === 'customer') &&
    typeof c.run === 'function' &&
    (c.timeoutMs === undefined || typeof c.timeoutMs === 'number') &&
    (c.ackOnStart === undefined || typeof c.ackOnStart === 'string')
  );
}
