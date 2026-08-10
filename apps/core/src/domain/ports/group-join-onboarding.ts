export type GroupJoinOnboardingStatus = 'prompted' | 'dismissed' | 'registered';

export interface GroupJoinOnboardingRecord {
  id: string;
  providerAccountId: string;
  chatJid: string;
  status: GroupJoinOnboardingStatus;
  adder: string;
  approver: string;
  promptConversationJid: string;
  promptAgentFolder: string;
  promptedAt: string;
  dismissedAt: string | null;
  registeredAt: string | null;
  leftAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GroupJoinOnboardingRepository {
  recordBootstrap(input: {
    id: string;
    providerAccountId: string;
    chatJid: string;
    adder: string;
    approver: string;
    promptConversationJid: string;
    promptAgentFolder: string;
    now: string;
  }): Promise<GroupJoinOnboardingRecord | null>;
  markRegistered(input: {
    id: string;
    now: string;
  }): Promise<GroupJoinOnboardingRecord | null>;
  revertRegistered(input: {
    id: string;
    now: string;
  }): Promise<GroupJoinOnboardingRecord | null>;
  markLeft(input: {
    providerAccountId: string;
    chatJid: string;
    now: string;
  }): Promise<GroupJoinOnboardingRecord | null>;
  hasDirectConversationWithPerson(
    appId: string,
    personId: string,
  ): Promise<boolean>;
  ensureInstallerParticipant(input: {
    conversationId: string;
    provider: string;
    providerAccountId: string;
    installerExternalId: string;
    now: string;
  }): Promise<void>;
}

export interface GroupJoinOnboardingCoordinator {
  beginBootstrap(input: {
    providerAccountId: string;
    chatJid: string;
    installerExternalId?: string;
  }): Promise<GroupJoinOnboardingRecord | null>;
  seedInstaller(input: {
    id: string;
    provider: string;
    externalId: string;
    title: string;
    installerExternalId: string;
  }): Promise<GroupJoinOnboardingRecord | null>;
  markLeft(input: {
    providerAccountId: string;
    chatJid: string;
  }): Promise<GroupJoinOnboardingRecord | null>;
}
