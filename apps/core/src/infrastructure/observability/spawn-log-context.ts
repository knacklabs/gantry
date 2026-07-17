import { withLogContext } from '../logging/logger.js';
import {
  createSpawnTurnTracker,
  type SpawnTurnTracker,
} from './spawn-turn-tracker.js';

interface SpawnLogTurnInput {
  runId?: string;
  appId?: string;
  agentId?: string;
  chatJid?: string;
  threadId?: string;
  jobId?: string;
  memoryUserId?: string;
  prompt: string;
}

interface SpawnLogFrame {
  status: string;
  result: string | null;
  error?: string;
  continuedByFollowup?: boolean;
}

export async function runSpawnWithLogContext<Frame extends SpawnLogFrame>(
  input: {
    agentName: string;
    turn: SpawnLogTurnInput;
    correlationRunId?: string;
    appId: string;
    agentId: string;
    onOutput: ((output: Frame) => Promise<void>) | undefined;
  },
  run: (tracker: SpawnTurnTracker<Frame>) => Promise<Frame>,
): Promise<Frame> {
  const turnTracker = createSpawnTurnTracker(
    input.agentName,
    { ...input.turn, runId: input.correlationRunId },
    input.onOutput,
  );
  const traceId = turnTracker.traceId();
  let output: Frame | undefined;
  return withLogContext(
    {
      runId: turnTracker.correlationId,
      appId: input.appId,
      agentId: input.agentId,
      ...(traceId ? { traceId } : {}),
    },
    async () => {
      try {
        output = await run(turnTracker);
        return output;
      } finally {
        turnTracker.finish(output);
      }
    },
  );
}
