import { SkillService } from '../application/skills/skill-service.js';
import type { AppId } from '../domain/app/app.js';
import type { PatternCandidateRepository } from '../domain/ports/pattern-candidates.js';
import type { TaskHandler } from './ipc-types.js';
type SkillInstallRuntimeDeps = {
    getStorage: () => {
        repositories: {
            skills: ConstructorParameters<typeof SkillService>[0];
            patternCandidates?: PatternCandidateRepository;
        };
        skillArtifacts: ConstructorParameters<typeof SkillService>[1];
    };
    logInfo: (context: Record<string, unknown>, message: string) => void;
    logError: (context: Record<string, unknown>, message: string) => void;
    syncApprovedCapabilitySettings: (appId: AppId) => Promise<void>;
};
export declare function configureSkillInstallHandlers(deps: SkillInstallRuntimeDeps): void;
export declare const requestSkillProposalHandler: TaskHandler;
export declare const requestSkillInstallHandler: TaskHandler;
export {};
