import { configureDefaultInlineAgentLoopLane, } from '../../runtime/agent-inline.js';
import { createInlineCoreToolsForRun } from './inline-agent-loop-tools.js';
export function resolveRuntimeDefaultAdapters(input) {
    const executionAdapters = input.executionAdapters ??
        input.llmAdapters.createDefaultAgentExecutionAdapterRegistry();
    const executionAdapter = input.executionAdapter ?? executionAdapters.list()[0];
    if (!executionAdapter) {
        throw new Error('Runtime requires at least one model execution adapter.');
    }
    const runnerSandboxProvider = input.runnerSandboxProvider ??
        input.llmAdapters.createDefaultRunnerSandboxProvider(input.sandboxSettings);
    configureDefaultInlineAgentLoopLane(input.llmAdapters.createDefaultInlineAgentLoopLane({
        databaseUrl: input.databaseUrl,
        databaseSchema: input.databaseSchema,
        createCoreTools: (laneInput, support) => createInlineCoreToolsForRun(laneInput, support),
        getEgressDenylist: input.getEgressDenylist,
    }));
    return {
        executionAdapter,
        executionAdapters,
        runnerSandboxProvider,
        memoryLlmClient: input.llmAdapters.createDefaultMemoryLlmClient(),
    };
}
