export const SUPPORTED_DEEPAGENTS_ASYNC_SUBAGENT_VERSION = '1.10.2';
export const DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE = 'Async delegation is unavailable for this DeepAgents version. Gantry did not start delegated work.';
export const EXPECTED_DEEPAGENTS_ASYNC_TOOL_SCHEMAS = {
    start_async_task: ['agentName', 'description'],
    check_async_task: ['taskId'],
    update_async_task: ['message', 'taskId'],
    cancel_async_task: ['taskId'],
    list_async_tasks: ['statusFilter'],
};
export const EXPECTED_DEEPAGENTS_ASYNC_TOOL_NAMES = Object.keys(EXPECTED_DEEPAGENTS_ASYNC_TOOL_SCHEMAS);
export function evaluateDeepAgentsAsyncSubagentSentinel(input) {
    const packageVersion = input.packageVersion.trim();
    if (packageVersion !== SUPPORTED_DEEPAGENTS_ASYNC_SUBAGENT_VERSION) {
        return fail('unsupported_package_version', { packageVersion });
    }
    const createMiddleware = input.deepagentsModule.createAsyncSubAgentMiddleware;
    const isAsyncSubAgent = input.deepagentsModule.isAsyncSubAgent;
    if (typeof createMiddleware !== 'function' ||
        typeof isAsyncSubAgent !== 'function') {
        return fail('missing_exports', { packageVersion });
    }
    if (isAsyncSubAgent({
        name: 'gantry_sentinel',
        description: 'Sentinel async subagent',
        graphId: 'gantry_sentinel_graph',
    }) !== true ||
        isAsyncSubAgent({
            name: 'gantry_sentinel',
            description: 'Sentinel sync subagent',
            prompt: 'not async',
        }) !== false) {
        return fail('async_discriminant_drift', { packageVersion });
    }
    let middleware;
    try {
        middleware = createMiddleware({
            asyncSubAgents: [
                {
                    name: 'gantry_sentinel',
                    description: 'Sentinel async subagent',
                    graphId: 'gantry_sentinel_graph',
                    url: 'http://127.0.0.1:9',
                },
            ],
            systemPrompt: null,
        });
    }
    catch {
        return fail('middleware_probe_failed', { packageVersion });
    }
    if (!middleware ||
        middleware.name !== 'asyncSubAgentMiddleware' ||
        !Array.isArray(middleware.tools)) {
        return fail('middleware_probe_failed', { packageVersion });
    }
    const tools = middleware.tools;
    const toolNames = tools
        .map((tool) => (typeof tool.name === 'string' ? tool.name : ''))
        .filter(Boolean);
    if (!sameStrings(toolNames, EXPECTED_DEEPAGENTS_ASYNC_TOOL_NAMES)) {
        return fail('tool_surface_drift', {
            packageVersion,
            toolNames,
            apiCompatible: false,
        });
    }
    for (const [toolName, expectedKeys] of Object.entries(EXPECTED_DEEPAGENTS_ASYNC_TOOL_SCHEMAS)) {
        const tool = tools.find((candidate) => candidate.name === toolName);
        const actualKeys = schemaShapeKeys(tool?.schema);
        if (!actualKeys || !sameStrings(actualKeys, expectedKeys)) {
            return fail('tool_schema_drift', {
                packageVersion,
                toolNames,
                apiCompatible: false,
            });
        }
    }
    if (input.gantryAgentProtocolTransportReady !== true) {
        return fail('gantry_transport_unavailable', {
            packageVersion,
            toolNames,
            apiCompatible: true,
        });
    }
    return {
        ok: true,
        packageVersion,
        toolNames,
        apiCompatible: true,
    };
}
function fail(reason, details = {}) {
    return {
        ok: false,
        reason,
        message: DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE,
        ...details,
    };
}
function sameStrings(actual, expected) {
    if (actual.length !== expected.length)
        return false;
    const sortedActual = [...actual].sort();
    const sortedExpected = [...expected].sort();
    return sortedExpected.every((value, index) => sortedActual[index] === value);
}
function schemaShapeKeys(schema) {
    const record = objectRecord(schema);
    if (!record)
        return null;
    const def = objectRecord(record._def);
    const shapeValue = record.shape ?? def?.shape;
    const shape = typeof shapeValue === 'function'
        ? shapeValue()
        : shapeValue;
    const shapeRecord = objectRecord(shape);
    return shapeRecord ? Object.keys(shapeRecord).sort() : null;
}
function objectRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
