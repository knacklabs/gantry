export function structuredOutputError(error, newSessionId) {
    const detail = error instanceof Error ? ` ${error.message}` : '';
    return {
        status: 'error',
        result: null,
        error: `Inline structured output failed schema validation.${detail}`,
        structuredOutputValidationFailure: true,
        newSessionId,
    };
}
export function abortedOutput(newSessionId) {
    return {
        status: 'error',
        result: null,
        error: 'Inline DeepAgents lane aborted.',
        ...(newSessionId ? { newSessionId } : {}),
    };
}
