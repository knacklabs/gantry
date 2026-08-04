import { withLogContext } from '../logging/logger.js';
import { createSpawnTurnTracker, } from './spawn-turn-tracker.js';
export async function runSpawnWithLogContext(input, run) {
    const turnTracker = createSpawnTurnTracker(input.agentName, { ...input.turn, runId: input.correlationRunId }, input.onOutput);
    const traceId = turnTracker.traceId();
    let output;
    return withLogContext({
        runId: turnTracker.correlationId,
        appId: input.appId,
        agentId: input.agentId,
        ...(traceId ? { traceId } : {}),
    }, async () => {
        try {
            output = await run(turnTracker);
            return output;
        }
        finally {
            turnTracker.finish(output);
        }
    });
}
