/** Gantry routing metadata, independent of Bot Framework activity shapes. */
export interface TeamsConversationRoute {
  conversationJid: string;
  serviceUrl: string;
  tenantId: string;
  botId: string;
  channelId: string;
  conversationType: string | null;
}

export interface TeamsConversationRouteStore {
  upsertForProviderAccounts(input: {
    providerAccountIds: readonly string[];
    route: TeamsConversationRoute;
  }): Promise<void>;
  get(input: {
    providerAccountId: string;
    conversationJid: string;
  }): Promise<TeamsConversationRoute | null>;
}
