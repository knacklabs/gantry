import { TelegramChannelConnect } from './channel-connect.js';
import { addTelegramReaction, removeTelegramReaction } from './reactions.js';

export abstract class TelegramChannelReactions extends TelegramChannelConnect {
  private readonly reactionKeys = new Set<string>();

  async addReaction(
    jid: string,
    messageRef: string,
    emoji: string,
  ): Promise<void> {
    if (!this.bot) return;
    await addTelegramReaction({
      bot: this.bot,
      jid,
      messageRef,
      emoji,
      reactionKeys: this.reactionKeys,
    });
  }

  async removeReaction(
    jid: string,
    messageRef: string,
    _emoji: string,
  ): Promise<void> {
    if (!this.bot) return;
    await removeTelegramReaction({
      bot: this.bot,
      jid,
      messageRef,
      reactionKeys: this.reactionKeys,
    });
  }
}
