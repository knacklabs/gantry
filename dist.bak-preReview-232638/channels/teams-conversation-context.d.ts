import type { NewMessage } from '../domain/types.js';
import type { ConversationContextHydrationRequest, ConversationContextHydrationResult } from './channel-provider.js';
import { type TeamsContextMessage, type TeamsSdkClient } from './teams-types.js';
export declare function hydrateTeamsConversationContext(request: ConversationContextHydrationRequest, sdkClient: TeamsSdkClient, botUserId: string | null): Promise<ConversationContextHydrationResult>;
export declare function teamsMessageAttachments(message: TeamsContextMessage): NonNullable<NewMessage['attachments']>;
