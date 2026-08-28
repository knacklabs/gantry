import type { DiscordProgressPost } from './progress-dispatch.js';
import type { CreateAttempt } from './progress-state.js';

export type DiscordProgressMutationSettlement = {
  mutationInvoked: boolean;
  mutationCompleted: boolean;
};

export function createTrackedDiscordProgressPost(input: {
  createAttempt?: CreateAttempt;
  post: DiscordProgressPost;
  settlement: DiscordProgressMutationSettlement;
}): DiscordProgressPost {
  return async (text, components, signal) => {
    input.settlement.mutationInvoked = true;
    input.settlement.mutationCompleted = false;
    if (input.createAttempt?.overflowPayloadFingerprint) {
      input.createAttempt.overflowPostInvoked = true;
    }
    const result = await input.post(text, components, signal);
    input.settlement.mutationCompleted = true;
    return result;
  };
}
