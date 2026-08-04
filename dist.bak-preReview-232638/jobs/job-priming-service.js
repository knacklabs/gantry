import { requestPermissionReviewSuggestions } from './request-permission-review.js';
export class JobPrimingService {
    formatPermissionSuggestions(attempts) {
        const formatted = [];
        const seen = new Set();
        for (const attempt of attempts) {
            const suggestions = normalizeSuggestionList(attempt.suggestions ??
                requestPermissionReviewSuggestions({
                    permissionKind: 'tool',
                    toolName: attempt.toolName,
                }));
            if (!suggestions)
                continue;
            const key = JSON.stringify({
                toolName: attempt.toolName,
                requestedToolName: attempt.requestedToolName,
                suggestions,
            });
            if (seen.has(key))
                continue;
            seen.add(key);
            formatted.push({
                toolName: attempt.toolName,
                requestedToolName: attempt.requestedToolName,
                suggestions,
            });
        }
        return formatted;
    }
}
function normalizeSuggestionList(suggestions) {
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
        return undefined;
    }
    return suggestions;
}
