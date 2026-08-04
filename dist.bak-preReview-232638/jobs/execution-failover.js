import { describeFailover, executionProviderIdForCandidate, shouldFailoverToNextCandidate, } from '../runtime/failover-candidate-loop.js';
// Jobs-lane model-family failover around the agent spawn. Re-spawns the run on
// the NEXT configured candidate UNDER THE SAME lease (no re-claim, no new
// fencing version — that is reserved for stale-lease recovery) while NO visible
// output has streamed and the error is provider-specific. The streamed-output
// guard (`hasStreamedOutput`) is the load-bearing safety boundary: a provider
// failing after a streamed delta must not re-spawn. The loop is bounded to the
// candidate count, never infinite. `timeoutMs` is enforced per attempt by the
// runner (each spawn receives the same runOptions); the caller's lease heartbeat
// covers the wall-clock budget across attempts.
export async function runJobAgentWithFailover(input) {
    const runAttempt = (model) => input.spawn(input.group, { ...input.baseInput, ...(model ? { model } : {}) }, input.onProcess, input.streamHandler, input.runOptions);
    let output = await runAttempt(input.firstModel);
    const candidateCount = Math.max(1, input.candidates.length);
    for (let attempt = 0; shouldFailoverToNextCandidate({
        status: output.status,
        error: output.error,
        hasStreamedOutput: input.hasStreamedOutput(),
        attempt,
        candidateCount,
    }); attempt += 1) {
        const toModel = input.candidates[attempt + 1];
        if (!toModel)
            break;
        const toProviderId = executionProviderIdForCandidate(toModel, input.fallbackProviderId, input.agentHarness);
        const fromModel = input.candidates[attempt] ?? input.firstModel ?? '(default)';
        const fromProviderId = await input.onFailover(toProviderId, {
            toProviderId,
            fromModel,
            toModel,
            reason: output.error,
        });
        input.log(describeFailover({
            fromProviderId,
            toProviderId,
            fromModel,
            toModel,
            reason: output.error,
        }));
        output = await runAttempt(toModel);
    }
    return output;
}
