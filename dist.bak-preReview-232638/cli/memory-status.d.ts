import { type MemoryHealthInspection } from './memory-health.js';
export type MemoryMode = 'keyword-mode' | 'continuity-mode' | 'semantic-mode' | 'full-mode';
export interface MemoryStatusSnapshot {
    runtimeHome: string;
    health: MemoryHealthInspection;
    mode: MemoryMode;
    modeNote: string | null;
}
export declare function deriveMemoryMode(health: MemoryHealthInspection): {
    mode: MemoryMode;
    note: string | null;
};
export declare function collectMemoryStatus(runtimeHome: string): MemoryStatusSnapshot;
export declare function formatMemoryStatusExtras(snapshot: MemoryStatusSnapshot): string;
