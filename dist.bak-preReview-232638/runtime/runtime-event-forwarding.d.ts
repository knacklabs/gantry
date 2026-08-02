import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type { AgentOutput } from './agent-spawn.js';
export { RUNTIME_EVENT_TYPES };
export declare function forwardRuntimeEvents(input: {
    output: AgentOutput;
    publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<void> | void;
    runtimeAppId: string;
    turnAgentId?: string;
    runId?: string;
    chatJid: string;
    sessionThreadId: string | null;
    forwardedKeys: Set<string>;
}): Promise<void>;
