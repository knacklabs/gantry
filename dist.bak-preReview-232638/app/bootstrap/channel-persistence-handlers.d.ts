import type { NewMessage } from '../../domain/types.js';
import type { RuntimeChatMetadataRepository, RuntimeMessageRepository } from '../../domain/repositories/ops-repo.js';
import type { RuntimeApp } from './runtime-app.js';
import type { AsyncTaskQueue } from './async-task-queue.js';
import type { ChannelWiringDeps } from './channel-wiring-types.js';
type ChannelPersistenceRepository = RuntimeChatMetadataRepository & RuntimeMessageRepository;
type BrainHarvestRuntimeSettings = Parameters<NonNullable<ChannelWiringDeps['brainHarvestTap']>['harvest']>[0]['settings'];
interface ChannelPersistenceHandlerDeps {
    app: RuntimeApp;
    resolved: ChannelWiringDeps;
    ops: () => ChannelPersistenceRepository;
    persistenceQueue: AsyncTaskQueue;
    runtimeSettings: () => BrainHarvestRuntimeSettings;
}
export declare function createChannelPersistenceHandlers({ app, resolved, ops, persistenceQueue, runtimeSettings, }: ChannelPersistenceHandlerDeps): {
    groupJoinOnboarding: import("../../domain/ports/group-join-onboarding.js").GroupJoinOnboardingCoordinator | undefined;
    ensureMessageRoute: (chatJid: string, msg: NewMessage) => Promise<boolean>;
    onMessage: (chatJid: string, msg: NewMessage) => Promise<void>;
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean, options?: {
        providerAccountId?: string;
    }) => Promise<void>;
};
export {};
