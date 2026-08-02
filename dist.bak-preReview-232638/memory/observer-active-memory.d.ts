import type { ObserverSubjectKey } from '../domain/ports/observer-insights.js';
export interface ObserverActiveMemoryReadPort {
    listActiveValues(input: {
        appId: string;
        subject: ObserverSubjectKey;
    }): Promise<readonly string[]>;
}
export declare function loadCanonicalActiveMemoryValues(input: {
    memory: ObserverActiveMemoryReadPort;
    appId: string;
    subject: ObserverSubjectKey;
}): Promise<ReadonlySet<string>>;
export declare function hasExactActiveMemoryMatch(input: {
    memory: ObserverActiveMemoryReadPort;
    appId: string;
    subject: ObserverSubjectKey;
    candidateText: string;
}): Promise<boolean>;
