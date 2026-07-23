export type DiscordGatewayPayload = {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
};

export type DiscordUser = {
  id?: string;
  username?: string;
  bot?: boolean;
};

export type DiscordMessageCreate = {
  id?: string;
  channel_id?: string;
  guild_id?: string;
  content?: string;
  timestamp?: string;
  author?: DiscordUser;
  member?: {
    nick?: string | null;
    user?: DiscordUser;
  };
  attachments?: DiscordMessageAttachment[];
  referenced_message?: {
    id?: string;
    content?: string;
    author?: DiscordUser;
  } | null;
};

export type DiscordMessageAttachment = {
  id?: string;
  filename?: string;
  content_type?: string;
  size?: number;
};

export type DiscordChannelInfo = {
  id?: string;
  type?: number;
  parent_id?: string | null;
};

export type DiscordInteraction = {
  id?: string;
  token?: string;
  type?: number;
  channel_id?: string;
  data?: {
    name?: string;
    custom_id?: string;
    options?: Array<DiscordInteractionOption>;
  };
  member?: {
    user?: DiscordUser;
    nick?: string | null;
  };
  user?: DiscordUser;
  message?: {
    id?: string;
  };
};

export type DiscordInteractionOption = {
  name?: string;
  type?: number;
  value?: string | number | boolean;
  options?: Array<DiscordInteractionOption>;
};

export type WebSocketLike = {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;
