export function isSuccessfulMcpActivity(activity) {
    if (activity.outcome !== 'success' ||
        activity.error ||
        activity.structuredError) {
        return false;
    }
    if (isMcpErrorResult(activity.result))
        return false;
    if (activity.resultClass !== undefined) {
        return activity.resultClass === 'success';
    }
    return activity.result !== undefined;
}
export function isMcpErrorResult(result) {
    return (result !== null &&
        typeof result === 'object' &&
        !Array.isArray(result) &&
        result.isError === true);
}
