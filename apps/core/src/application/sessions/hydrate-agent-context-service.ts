import type { AgentSessionId } from '../../domain/sessions/sessions.js';
import { notImplemented } from '../common/application-error.js';

export class HydrateAgentContextService {
  async hydrate(input: { sessionId: AgentSessionId }) {
    void input;
    // TODO(next-phase): compose memory, recent messages, config, and workspace context here.
    throw notImplemented('HydrateAgentContextService');
  }
}
