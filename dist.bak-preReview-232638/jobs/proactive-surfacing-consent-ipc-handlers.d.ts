import type { ProactiveSurfacingOptIn, ProactiveSurfacingSubject } from '../domain/ports/proactive-surfacing-consent.js';
import type { TaskHandler } from './ipc-types.js';
type ProactiveSurfacingRepository = {
    getBySubject(subject: ProactiveSurfacingSubject): Promise<ProactiveSurfacingOptIn | null>;
    setEnabled(input: {
        subject: ProactiveSurfacingSubject;
        id: string;
        actorId?: string | null;
        nowIso: string;
    }): Promise<ProactiveSurfacingOptIn>;
    setOptedOut(input: {
        subject: ProactiveSurfacingSubject;
        actorId?: string | null;
        nowIso: string;
    }): Promise<ProactiveSurfacingOptIn | null>;
};
type ProactiveSurfacingConsentRuntimeDeps = {
    getStorage: () => {
        repositories: {
            proactiveSurfacing?: ProactiveSurfacingRepository;
        };
    };
};
export declare function configureProactiveSurfacingConsentIpcHandlers(deps: ProactiveSurfacingConsentRuntimeDeps): void;
export declare const proactiveSurfacingConsentHandler: TaskHandler;
export {};
