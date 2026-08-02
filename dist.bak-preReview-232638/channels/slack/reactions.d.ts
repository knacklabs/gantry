export declare function slackReactionName(emoji: string): string;
export declare function isSlackAlreadyReactedError(err: unknown): boolean;
export declare function addSlackReaction(input: {
    app: {
        client: {
            reactions: {
                add(args: unknown): Promise<unknown>;
            };
        };
    };
    jid: string;
    channelId: string;
    messageRef: string;
    emoji: string;
    reactionKeys: Set<string>;
}): Promise<void>;
