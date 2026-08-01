import type { MessageAttachmentsDeleted } from './channel-provider.js';
import type {
  DiscordContextRequestJson,
  DiscordConversationContextCache,
} from './discord-conversation-context.js';
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
    botToken: string;
    cache: DiscordConversationContextCache;
    requestJson: DiscordContextRequestJson;
    onReady: (ready: { user?: DiscordUser; session_id?: string }) => void;
    onMessageCreate: (message: DiscordMessageCreate) => Promise<void>;
    onInteraction: (interaction: DiscordInteraction) => Promise<void>;
    onMessageAttachmentsDeleted?: (
      event: MessageAttachmentsDeleted,
    ) => Promise<void>;
  },
): Promise<void> {
  if (payload.t === 'READY') {
    input.onReady(payload.d as { user?: DiscordUser; session_id?: string });
    return;
  }
  if (payload.t === 'MESSAGE_CREATE') {
    await input.onMessageCreate(payload.d as DiscordMessageCreate);
    return;
  }
  if (
    await routeDiscordDeletion(
      payload,
      input.botToken,
      input.cache,
      input.requestJson,
      input.onMessageAttachmentsDeleted,
    )
  ) {
    return;
  }
  if (payload.t === 'INTERACTION_CREATE') {
    await input.onInteraction(payload.d as DiscordInteraction);
  }
}
