import type { AgentRunId } from '../../domain/events/events.js';
import type { RunEventStreamPort } from '../runs/run-event-stream-port.js';

export class StreamRunEventsUseCase {
  constructor(private readonly stream: RunEventStreamPort) {}

  execute(input: { runId?: AgentRunId }) {
    return this.stream.subscribe(input);
  }
}
