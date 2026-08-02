import type { GroupJoinOnboardingCoordinator, GroupJoinOnboardingRepository } from '../../domain/ports/group-join-onboarding.js';
import { writeDesiredRuntimeSettings } from './desired-settings-writer.js';
import type { RuntimeSettings } from './runtime-settings-types.js';
interface GroupJoinCoordinatorDeps {
    runtimeHome: string;
    repository: () => GroupJoinOnboardingRepository;
    loadSettings: () => Promise<RuntimeSettings>;
    writeSettings: typeof writeDesiredRuntimeSettings;
    reloadRuntimeState: () => Promise<void>;
    now: () => string;
    newId: () => string;
}
export declare function createGroupJoinOnboardingCoordinator(deps: Partial<GroupJoinCoordinatorDeps> & Pick<GroupJoinCoordinatorDeps, 'runtimeHome' | 'repository' | 'reloadRuntimeState'>): GroupJoinOnboardingCoordinator;
export {};
