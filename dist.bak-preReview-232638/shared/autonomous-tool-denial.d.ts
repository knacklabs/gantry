export interface AutonomousToolDenial {
    toolName: string;
    recoveryAction?: string;
}
export declare function parseAutonomousToolDenial(value: string | null | undefined): AutonomousToolDenial | null;
