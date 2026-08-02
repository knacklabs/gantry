import { Ajv } from 'ajv';
import { DEFAULT_AGENT_ENGINE } from '../../shared/agent-engine.js';
export const DEFAULT_INLINE_AGENT_MAX_TURNS = 50;
const RESPONSE_SCHEMA_RETRY_LIMIT = 1;
const RESPONSE_SCHEMA_REPAIR_CANDIDATE_LIMIT = 4_096;
const responseSchemaCompiler = new Ajv({
    addUsedSchema: false,
    allErrors: true,
    strict: false,
});
export function inlineAgentMaxTurnsError(limit, newSessionId) {
    return {
        status: 'error',
        result: null,
        error: `Inline agent reached the max_turns cap (configured limit: ${limit}).`,
        ...(newSessionId ? { newSessionId } : {}),
    };
}
export function createInlineAgentLoopLaneDispatcher(input) {
    return async (laneInput) => {
        if (!laneInput.resolvedModel.ok) {
            return {
                status: 'error',
                result: null,
                error: laneInput.resolvedModel.message,
            };
        }
        const lane = laneInput.resolvedModel.value.agentEngine === DEFAULT_AGENT_ENGINE
            ? input.claudeLane
            : input.deepAgentsLane;
        const coreTools = await input.createCoreTools(laneInput);
        const egressDenylist = input.getEgressDenylist();
        if (!laneInput.input.responseSchema) {
            return lane({ ...laneInput, coreTools, egressDenylist });
        }
        let validate;
        try {
            validate = responseSchemaCompiler.compile(laneInput.input.responseSchema);
        }
        catch (error) {
            const terminal = responseSchemaFailure(`response_schema could not be compiled: ${errorMessage(error)}`, null, laneInput.input.sessionId);
            await laneInput.emitOutput(terminal);
            return terminal;
        }
        let attemptInput = laneInput;
        for (let attempt = 0;; attempt += 1) {
            const output = await lane({
                ...attemptInput,
                coreTools,
                egressDenylist,
                emitOutput: async (frame) => {
                    if (isObservableNonTerminalFrame(frame)) {
                        await laneInput.emitOutput(frame);
                    }
                },
            });
            if (output.status === 'error' &&
                output.structuredOutputValidationFailure !== true) {
                await laneInput.emitOutput(output);
                return output;
            }
            const validation = output.status === 'error'
                ? {
                    valid: false,
                    error: output.error ??
                        'the provider could not produce output matching response_schema',
                }
                : validateResponse(output.result, validate);
            if (validation.valid) {
                await laneInput.emitOutput(output);
                return output;
            }
            await emitInvalidAttemptUsage(laneInput.emitOutput, output);
            if (attempt >= RESPONSE_SCHEMA_RETRY_LIMIT) {
                const terminal = responseSchemaFailure(`Inline response failed response_schema validation after ${RESPONSE_SCHEMA_RETRY_LIMIT} retry: ${validation.error}`, output.result, output.newSessionId);
                await laneInput.emitOutput(terminal);
                return terminal;
            }
            attemptInput = {
                ...laneInput,
                input: {
                    ...laneInput.input,
                    prompt: `${laneInput.input.prompt}\n\nYour previous response failed validation with: ${validation.error}\nFix it to satisfy response_schema.\n\nPrevious response:\n${boundedRepairCandidate(output.result)}\n\nReturn one corrected JSON response matching response_schema.`,
                    disableTools: true,
                },
            };
        }
    };
}
function boundedRepairCandidate(candidate) {
    if (candidate === null)
        return '(no candidate text)';
    if (candidate.length <= RESPONSE_SCHEMA_REPAIR_CANDIDATE_LIMIT) {
        return candidate;
    }
    return `${candidate.slice(0, RESPONSE_SCHEMA_REPAIR_CANDIDATE_LIMIT)}\n[truncated]`;
}
function validateResponse(candidate, validate) {
    if (candidate === null) {
        return { valid: false, error: 'the model returned no candidate text' };
    }
    let value;
    try {
        value = JSON.parse(candidate);
    }
    catch (error) {
        return {
            valid: false,
            error: `candidate is not valid JSON: ${errorMessage(error)}`,
        };
    }
    if (validate(value) === true)
        return { valid: true };
    const errors = validate.errors ?? [];
    return {
        valid: false,
        error: errors
            .slice(0, 3)
            .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
            .join('; ') || '/ is invalid',
    };
}
function responseSchemaFailure(error, candidate, newSessionId) {
    return {
        status: 'error',
        result: candidate,
        error,
        failure: {
            type: 'execution',
            attemptedAction: 'Validate inline response against response_schema',
            partialResult: candidate,
        },
        ...(newSessionId ? { newSessionId } : {}),
    };
}
async function emitInvalidAttemptUsage(emitOutput, frame) {
    if (!frame.usage &&
        !frame.usageEventId &&
        !frame.contextUsage &&
        !frame.runtimeEvents?.length) {
        return;
    }
    await emitOutput({
        status: 'success',
        result: null,
        runtimeEventOnly: true,
        ...(frame.newSessionId ? { newSessionId: frame.newSessionId } : {}),
        ...(frame.usage ? { usage: frame.usage } : {}),
        ...(frame.usageEventId ? { usageEventId: frame.usageEventId } : {}),
        ...(frame.contextUsage ? { contextUsage: frame.contextUsage } : {}),
        ...(frame.runtimeEvents ? { runtimeEvents: frame.runtimeEvents } : {}),
    });
}
function isObservableNonTerminalFrame(output) {
    return Boolean(output.sessionInit ||
        output.runtimeEventOnly ||
        output.compactBoundary ||
        output.interactionBoundary);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
