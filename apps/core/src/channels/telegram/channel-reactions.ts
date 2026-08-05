import { TelegramChannelConnect } from './channel-connect.js';
import { addTelegramReaction, removeTelegramReaction } from './reactions.js';
import { translateTelegramLiveUxError } from './live-ux.js';

export abstract class TelegramChannelReactions extends TelegramChannelConnect {
  private readonly reactionKeys = new Set<string>();

  async addReaction(
    jid: string,
    messageRef: string,
    emoji: string,
    options: {
      threadId?: string;
      signal?: AbortSignal;
      reconcile?: boolean;
    } = {},
  ): Promise<void> {
    if (!this.bot) return;
    try {
      await addTelegramReaction({
        bot: this.bot,
        jid,
        messageRef,
        emoji,
        reactionKeys: this.reactionKeys,
        signal: options.signal,
        reconcile: options.reconcile,
      });
    } catch (err) {
      translateTelegramLiveUxError(err);
    }
  }

  async removeReaction(
    jid: string,
    messageRef: string,
    _emoji: string,
    options: { threadId?: string; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!this.bot) return;
    try {
      await removeTelegramReaction({
        bot: this.bot,
        jid,
        messageRef,
        reactionKeys: this.reactionKeys,
        signal: options.signal,
      });
    } catch (err) {
      translateTelegramLiveUxError(err);
    }
  }
}
