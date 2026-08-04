export function createSpawnAgent(deps) {
    return async function spawnAgent(group, input, onProcess, onOutput, options) {
        const spawnInput = deps.stripIncompleteRunLeaseIdentity(input);
        return deps.runWithLogContext({
            ...deps.resolveLogContext(group, input, options?.correlationRunId),
            onOutput,
        }, (turnTracker) => deps.spawnWithContext(group, spawnInput, onProcess, options, turnTracker));
    };
}
