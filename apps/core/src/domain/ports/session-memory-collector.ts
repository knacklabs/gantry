export type MemoryBoundaryTrigger = 'precompact' | 'session-end';

export type MemoryBoundaryTurn = {
  role: 'user' | 'assistant';
  text: string;
};

export type SessionMemoryCollector = (input: {
  agentSessionId: string;
  trigger: MemoryBoundaryTrigger;
  additionalTurns?: MemoryBoundaryTurn[];
}) => Promise<{ saved: number }>;
