export interface ConversationIngressCursor {
  providerAccountId: string;
  conversationId: string;
  coveredThroughExternalId?: string;
  coveredThroughTimestamp: string;
  version: number;
  updatedAt: string;
}

export interface ConversationIngressCursorRepository {
  get(input: {
    providerAccountId: string;
    conversationId: string;
  }): Promise<ConversationIngressCursor | null>;
  advance(input: {
    providerAccountId: string;
    conversationId: string;
    expectedVersion: number;
    coveredThroughExternalId?: string;
    coveredThroughTimestamp: string;
    updatedAt: string;
  }): Promise<
    | { status: 'advanced'; cursor: ConversationIngressCursor }
    | { status: 'stale'; cursor: ConversationIngressCursor }
  >;
}

export interface ConversationIngressRecoveryTarget {
  agentId: string;
  providerAccountId: string;
  conversationId: string;
  externalConversationId: string;
  installedAt: string;
}

export interface ConversationIngressRecovery {
  listTargets(
    providerAccountId: string,
  ): Promise<ConversationIngressRecoveryTarget[]>;
  getCursor(target: ConversationIngressRecoveryTarget): Promise<{
    coveredThroughExternalId?: string;
    coveredThroughTimestamp: string;
    version: number;
  } | null>;
  advanceCursor(input: {
    target: ConversationIngressRecoveryTarget;
    expectedVersion: number;
    coveredThroughExternalId?: string;
    coveredThroughTimestamp: string;
  }): Promise<'advanced' | 'stale'>;
  publish(input: {
    target: ConversationIngressRecoveryTarget;
    eventType:
      | 'channel.replay.started'
      | 'channel.replay.completed'
      | 'channel.replay.failed';
    payload: Record<string, unknown>;
  }): Promise<void>;
}
