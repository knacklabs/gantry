import { incrementOperationalError } from '../shared/operational-error-counters.js';
export function recordJobAgentRunFailure() {
    incrementOperationalError('jobs', 'agent_run');
}
function recordJobTerminalSettlementFailure() {
    incrementOperationalError('jobs', 'terminal_settlement');
}
function terminalSettlementError(message) {
    recordJobTerminalSettlementFailure();
    return new Error(message);
}
export async function requireTerminalSettlement(operation, unavailableMessage, staleMessage) {
    if (!operation)
        throw terminalSettlementError(unavailableMessage);
    let settled;
    try {
        settled = await operation;
    }
    catch (error) {
        recordJobTerminalSettlementFailure();
        throw error;
    }
    if (!settled)
        throw terminalSettlementError(staleMessage);
}
