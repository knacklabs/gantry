export interface OperationalErrorKindsBySubsystem {
  channels: 'permission_prompt';
  delivery:
    | 'ambiguous_settlement'
    | 'notification_enqueue'
    | 'notification_send'
    | 'outbound_dispatch'
    | 'partial_settlement'
    | 'sent_settlement';
  interaction: 'permission_request' | 'user_question_request';
  ipc: 'message_dispatch' | 'task_dispatch';
  jobs: 'agent_run' | 'terminal_settlement';
  memory: 'ipc_request';
}

export type OperationalErrorSubsystem = keyof OperationalErrorKindsBySubsystem;
export type OperationalErrorKind =
  OperationalErrorKindsBySubsystem[OperationalErrorSubsystem];

export interface OperationalErrorCounter {
  subsystem: OperationalErrorSubsystem;
  kind: OperationalErrorKind;
  count: number;
}

const counters = new Map<string, OperationalErrorCounter>();

function counterKey(
  subsystem: OperationalErrorSubsystem,
  kind: OperationalErrorKind,
): string {
  return `${subsystem}:${kind}`;
}

export function incrementOperationalError<
  Subsystem extends OperationalErrorSubsystem,
>(
  subsystem: Subsystem,
  kind: OperationalErrorKindsBySubsystem[Subsystem],
): void {
  const key = counterKey(subsystem, kind);
  const current = counters.get(key);
  if (current) {
    current.count += 1;
    return;
  }
  counters.set(key, { subsystem, kind, count: 1 });
}

export function getOperationalErrorCount<
  Subsystem extends OperationalErrorSubsystem,
>(
  subsystem: Subsystem,
  kind: OperationalErrorKindsBySubsystem[Subsystem],
): number {
  return counters.get(counterKey(subsystem, kind))?.count ?? 0;
}

export function snapshotOperationalErrors(): readonly OperationalErrorCounter[] {
  return [...counters.values()];
}
