import type { Filter } from 'grammy';
import type { ChannelOpts } from '../channel-provider.js';
import type { TelegramContext } from './channel-shared.js';
type AuthorizeApprover = (chatId: string, userId: string, sourceAgentFolder: string) => Promise<boolean>;
export declare function handleTelegramGroupMembershipUpdate(input: {
    ctx: Filter<TelegramContext, 'my_chat_member'>;
    opts: ChannelOpts;
    assistantName: string;
    isApproverAuthorized: AuthorizeApprover;
    sanitizeErrorMessage: (err: unknown) => string;
}): Promise<void>;
export declare function handleTelegramGroupJoinCallback(input: {
    ctx: any;
    opts: ChannelOpts;
    assistantName: string;
    isApproverAuthorized: AuthorizeApprover;
    sanitizeErrorMessage: (err: unknown) => string;
}): Promise<boolean>;
export {};
