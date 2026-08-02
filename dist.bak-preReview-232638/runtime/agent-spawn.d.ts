import { ConversationRoute } from '../domain/types.js';
import { AgentInput, AgentOutput, RunAgentOptions } from './agent-spawn-types.js';
export { writeGroupsSnapshot } from './agent-spawn-snapshots.js';
export type { AvailableGroup } from './agent-spawn-types.js';
export type { AgentInput, AgentOutput } from './agent-spawn-types.js';
export declare const spawnAgent: (group: ConversationRoute, input: AgentInput, onProcess: import("./agent-spawn-types.js").RunnerProcessSpec["onProcess"], onOutput: ((output: AgentOutput) => Promise<void>) | undefined, options: RunAgentOptions) => Promise<AgentOutput>;
