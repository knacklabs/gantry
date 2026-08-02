export interface MessageReactionSink {
  addReaction(
    jid: string,
    messageRef: string,
    emoji: string,
    options?: { threadId?: string },
  ): Promise<void>;
}

export interface MessageReactionRemovalSink {
  removeReaction: MessageReactionSink['addReaction'];
}

export interface TypingSink {
  setTyping(
    jid: string,
    isTyping: boolean,
    options?: { threadId?: string },
  ): Promise<void>;
}
