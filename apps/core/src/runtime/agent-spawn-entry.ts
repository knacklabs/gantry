import type { ConversationRoute } from '../domain/types.js';
import type {
  AgentInput,
  AgentOutput,
  RunAgentOptions,
  RunnerProcessSpec,
} from './agent-spawn-types.js';

interface SpawnTurnTrackerLike {
  correlationId: string;
  traceId: () => string | undefined;
  onOutput: ((output: AgentOutput) => Promise<void>) | undefined;
  finish: (output: AgentOutput | undefined) => void;
}

interface SpawnLogContextInput {
  agentName: string;
  turn: AgentInput;
  correlationRunId?: string;
  appId: string;
  agentId: string;
  onOutput: ((output: AgentOutput) => Promise<void>) | undefined;
}

interface CreateSpawnAgentDeps {
  runWithLogContext: (
    input: SpawnLogContextInput,
    run: (tracker: SpawnTurnTrackerLike) => Promise<AgentOutput>,
  ) => Promise<AgentOutput>;
  resolveLogContext: (
    group: ConversationRoute,
    input: AgentInput,
    correlationRunId?: string,
  ) => Omit<SpawnLogContextInput, 'onOutput'>;
  stripIncompleteRunLeaseIdentity: (input: AgentInput) => AgentInput;
  spawnWithContext: (
    group: ConversationRoute,
    input: AgentInput,
    onProcess: RunnerProcessSpec['onProcess'],
    options: RunAgentOptions,
    turnTracker: SpawnTurnTrackerLike,
  ) => Promise<AgentOutput>;
}

export function createSpawnAgent(deps: CreateSpawnAgentDeps) {
  return async function spawnAgent(
    group: ConversationRoute,
    input: AgentInput,
    onProcess: RunnerProcessSpec['onProcess'],
    onOutput: ((output: AgentOutput) => Promise<void>) | undefined,
    options: RunAgentOptions,
  ): Promise<AgentOutput> {
    const spawnInput = deps.stripIncompleteRunLeaseIdentity(input);
    return deps.runWithLogContext(
      {
        ...deps.resolveLogContext(group, input, options?.correlationRunId),
        onOutput,
      },
      (turnTracker) =>
        deps.spawnWithContext(
          group,
          spawnInput,
          onProcess,
          options,
          turnTracker,
        ),
    );
  };
}
