import type { AgentRunEvent, AgentRunId } from '../../domain/events/events.js';

export interface RunEventStreamPort {
  subscribe(input: { runId?: AgentRunId }): AsyncIterable<AgentRunEvent>;
}
