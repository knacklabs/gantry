export interface JobSetupLabelBlocker {
    state?: string;
    requirementType?: string;
    requirementId?: string;
    nextAction?: string;
}
export declare function jobSetupBlockerFromUnknown(value: unknown): JobSetupLabelBlocker | undefined;
export declare function setupBlockerLabel(blocker: JobSetupLabelBlocker | undefined, fallbackState: string): string;
export declare function setupActionLabel(blocker: JobSetupLabelBlocker | undefined): string;
export declare function setupActionLabelFromNextAction(nextAction: unknown, fallback?: string): string;
/**
 * Public 4-state job readiness label. Maps the internal setup states to the
 * user-facing model: Ready / Needs approval / Needs connection / Blocked.
 */
export declare function setupReadinessLabel(state: string | undefined): string;
