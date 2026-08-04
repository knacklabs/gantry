import { incrementOperationalError } from '../shared/operational-error-counters.js';

export function recordJobAgentRunFailure(): void {
  incrementOperationalError('jobs', 'agent_run');
}

function recordJobTerminalSettlementFailure(): void {
  incrementOperationalError('jobs', 'terminal_settlement');
}

function terminalSettlementError(message: string): Error {
  recordJobTerminalSettlementFailure();
  return new Error(message);
}

export async function requireTerminalSettlement(
  operation: Promise<boolean> | undefined,
  unavailableMessage: string,
  staleMessage: string,
): Promise<void> {
  if (!operation) throw terminalSettlementError(unavailableMessage);
  let settled: boolean;
  try {
    settled = await operation;
  } catch (error) {
    recordJobTerminalSettlementFailure();
    throw error;
  }
  if (!settled) throw terminalSettlementError(staleMessage);
}
