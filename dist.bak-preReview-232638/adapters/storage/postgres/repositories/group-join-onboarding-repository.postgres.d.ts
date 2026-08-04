import type { GroupJoinOnboardingRecord, GroupJoinOnboardingRepository } from '../../../../domain/ports/group-join-onboarding.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresGroupJoinOnboardingRepository implements GroupJoinOnboardingRepository {
    private readonly db;
    constructor(db: CanonicalDb);
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
