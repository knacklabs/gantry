export interface OperationalErrorKindsBySubsystem {
    channels: 'permission_prompt';
    delivery: 'ambiguous_settlement' | 'notification_enqueue' | 'notification_send' | 'outbound_dispatch' | 'partial_settlement' | 'sent_settlement';
    interaction: 'permission_request' | 'user_question_request';
    ipc: 'message_dispatch' | 'task_dispatch';
    jobs: 'agent_run' | 'terminal_settlement';
    memory: 'ipc_request';
}
export type OperationalErrorSubsystem = keyof OperationalErrorKindsBySubsystem;
export type OperationalErrorKind = OperationalErrorKindsBySubsystem[OperationalErrorSubsystem];
export interface OperationalErrorCounter {
    subsystem: OperationalErrorSubsystem;
    kind: OperationalErrorKind;
    count: number;
}
export declare function incrementOperationalError<Subsystem extends OperationalErrorSubsystem>(subsystem: Subsystem, kind: OperationalErrorKindsBySubsystem[Subsystem]): void;
export declare function getOperationalErrorCount<Subsystem extends OperationalErrorSubsystem>(subsystem: Subsystem, kind: OperationalErrorKindsBySubsystem[Subsystem]): number;
export declare function snapshotOperationalErrors(): readonly OperationalErrorCounter[];
