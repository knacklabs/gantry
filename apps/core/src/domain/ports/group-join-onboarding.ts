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
  recordPrompt(input: {
    id: string;
    providerAccountId: string;
    chatJid: string;
    adder: string;
    approver: string;
    promptConversationJid: string;
    promptAgentFolder: string;
    now: string;
  }): Promise<GroupJoinOnboardingRecord>;
  getById(id: string): Promise<GroupJoinOnboardingRecord | null>;
  markDismissed(input: {
    id: string;
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
}

export interface GroupJoinOnboardingCoordinator {
  recordPrompt(input: {
    providerAccountId: string;
    chatJid: string;
    adder: string;
    approver: string;
    promptConversationJid: string;
    promptAgentFolder: string;
  }): Promise<GroupJoinOnboardingRecord>;
  getById(id: string): Promise<GroupJoinOnboardingRecord | null>;
  dismiss(id: string): Promise<GroupJoinOnboardingRecord | null>;
  register(input: {
    id: string;
    externalId: string;
    title: string;
    approvedBy: string;
  }): Promise<GroupJoinOnboardingRecord | null>;
  markLeft(input: {
    providerAccountId: string;
    chatJid: string;
  }): Promise<GroupJoinOnboardingRecord | null>;
}
