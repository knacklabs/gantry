import { notImplemented } from '../common/application-error.js';

export class TriggerJobUseCase {
  async execute(input: { appId: string; jobId: string }) {
    void input;
    // TODO(next-phase): move trigger persistence, rate limits, and event emission here together.
    throw notImplemented('TriggerJobUseCase');
  }
}
