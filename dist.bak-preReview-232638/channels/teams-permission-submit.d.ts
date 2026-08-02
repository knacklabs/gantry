import type { TeamsPermissionCallback } from './teams-types.js';
export declare function readTeamsPermissionDecision(value: unknown): {
    callback: TeamsPermissionCallback;
    decision: string;
} | null;
