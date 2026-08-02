import type { Pool } from 'pg';
import type { LiveAdmissionWakeupSource, LiveAdmissionWorkItemNotifier, LiveTurnCommandNotifier, LiveTurnCommandWakeupSource } from '../../../domain/ports/live-turns.js';
export declare const LIVE_ADMISSION_CHANNEL = "gantry_live_admissions";
export declare const LIVE_TURN_COMMAND_CHANNEL = "gantry_live_turn_commands";
export interface LiveAdmissionWakeup {
    appId: string;
    workItemId: string;
}
export interface LiveTurnCommandWakeup {
    liveTurnId: string;
    commandId: string;
}
export declare class PostgresLiveAdmissionNotifier implements LiveAdmissionWorkItemNotifier {
    private readonly pool;
    private readonly logWarn?;
    constructor(pool: Pool, logWarn?: ((context: Record<string, unknown>, message: string) => void) | undefined);
    notifyLiveAdmissionWorkItem(input: LiveAdmissionWakeup): Promise<void>;
}
export declare class PostgresLiveTurnCommandNotifier implements LiveTurnCommandNotifier {
    private readonly pool;
    private readonly logWarn?;
    constructor(pool: Pool, logWarn?: ((context: Record<string, unknown>, message: string) => void) | undefined);
    notifyLiveTurnCommand(input: LiveTurnCommandWakeup): Promise<void>;
}
export declare class PostgresLiveAdmissionWakeupSource implements LiveAdmissionWakeupSource {
    private readonly source;
    constructor(pool: Pool, logWarn?: (context: Record<string, unknown>, message: string) => void);
    subscribe(listener: () => void): () => void;
    close(): Promise<void>;
}
export declare class PostgresLiveTurnCommandWakeupSource implements LiveTurnCommandWakeupSource {
    private readonly source;
    constructor(pool: Pool, logWarn?: (context: Record<string, unknown>, message: string) => void);
    subscribe(listener: () => void): () => void;
    close(): Promise<void>;
}
