import { canonicalGantryToolRuleName } from '../../../../shared/gantry-tool-facades.js';
export function toolResponseIsError(response) {
    if (Array.isArray(response))
        return response.some(toolResponseIsError);
    if (!response || typeof response !== 'object')
        return false;
    const value = response;
    return (value.is_error === true ||
        value.isError === true ||
        value.status === 'error' ||
        Boolean(value.error) ||
        toolResponseIsError(value.content));
}
export function recordSuccessfulToolUse(hookInput, toolSuccessLedger) {
    if (toolResponseIsError(hookInput.tool_response))
        return;
    toolSuccessLedger.recordSuccess(canonicalGantryToolRuleName(hookInput.tool_name));
}
