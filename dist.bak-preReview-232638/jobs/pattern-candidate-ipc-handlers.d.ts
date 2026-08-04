import type { PatternCandidateRepository } from '../domain/ports/pattern-candidates.js';
import type { TaskHandler } from './ipc-types.js';
type PatternCandidateRuntimeDeps = {
    getStorage: () => {
        repositories: {
            patternCandidates?: PatternCandidateRepository;
        };
    };
};
export declare function configurePatternCandidateIpcHandlers(deps: PatternCandidateRuntimeDeps): void;
export declare const patternCandidateDecisionHandler: TaskHandler;
export {};
