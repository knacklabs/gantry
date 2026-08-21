import type { MessageAttachmentsDeleted } from './channel-provider.js';
import type { ConversationRoute } from '../domain/types.js';
import type { DiscordConversationContextCache } from './discord-conversation-context.js';
import { routeDiscordDeletion } from './discord-message-deletion.js';
import type {
  DiscordGatewayPayload,
  DiscordInteraction,
  DiscordMessageCreate,
  DiscordUser,
} from './discord-types.js';

export async function routeDiscordGatewayDispatch(
  payload: Pick<DiscordGatewayPayload, 't' | 'd'>,
  input: {
    cache: DiscordConversationContextCache;
    conversationRoutes: Record<string, ConversationRoute>;
    providerAccountIds: readonly string[];
    onReady: (ready: {
      user?: DiscordUser;
      session_id?: string;
      guilds?: Array<{ id?: string }>;
    }) => void;
    onMessageCreate: (message: DiscordMessageCreate) => Promise<void>;
    onInteraction: (interaction: DiscordInteraction) => Promise<void>;
    onMessageAttachmentsDeleted?: (
      event: MessageAttachmentsDeleted,
    ) => Promise<void>;
    onGuildCreate?: (guild: {
      id?: string;
      system_channel_id?: string | null;
      unavailable?: boolean;
    }) => Promise<void>;
  },
): Promise<void> {
  if (payload.t === 'READY') {
    input.onReady(
      payload.d as {
        user?: DiscordUser;
        session_id?: string;
        guilds?: Array<{ id?: string }>;
      },
    );
    return;
  }
  if (payload.t === 'MESSAGE_CREATE') {
    await input.onMessageCreate(payload.d as DiscordMessageCreate);
    return;
  }
  if (payload.t === 'GUILD_CREATE') {
    await input.onGuildCreate?.(
      payload.d as {
        id?: string;
        system_channel_id?: string | null;
        unavailable?: boolean;
      },
    );
    return;
  }
  if (
    await routeDiscordDeletion(
      payload,
      input.cache,
      input.conversationRoutes,
      input.providerAccountIds,
      input.onMessageAttachmentsDeleted,
    )
  ) {
    return;
  }
  if (payload.t === 'INTERACTION_CREATE') {
    await input.onInteraction(payload.d as DiscordInteraction);
  }
}
