export type MemoryBoundaryTrigger = 'precompact' | 'session-end';
export type MemoryBoundaryDefaultScope = 'user' | 'group';

export type MemoryBoundaryTurn = {
  role: 'user' | 'assistant';
  text: string;
};

export type SessionMemoryCollector = (input: {
  agentSessionId: string;
  trigger: MemoryBoundaryTrigger;
  defaultScope?: MemoryBoundaryDefaultScope;
  additionalTurns?: MemoryBoundaryTurn[];
}) => Promise<{ saved: number }>;
