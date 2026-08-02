const SLACK_LIMITS = { buttonText: 75, actionValue: 2000 };
export function truncateSlackText(text, maxLen) {
    if (text.length <= maxLen)
        return text;
    // Reserve room for the ellipsis so the result never exceeds maxLen — Slack
    // rejects the whole message when a header (150) or button (75) runs over.
    return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}
export function truncateSlackButtonText(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return 'Option';
    return truncateSlackText(trimmed, SLACK_LIMITS.buttonText);
}
export function encodeSlackActionValue(value) {
    const serialized = JSON.stringify(value);
    if (serialized.length <= SLACK_LIMITS.actionValue) {
        return serialized;
    }
    return JSON.stringify({
        callback: value.callback,
    });
}
export function parseSlackUserQuestionActionValue(rawValue) {
    if (!rawValue)
        return null;
    try {
        const parsed = JSON.parse(rawValue);
        const callback = readDurableQuestionCallback(parsed.callback);
        if (!callback)
            return null;
        if (parsed.optionIndex !== undefined &&
            !Number.isInteger(parsed.optionIndex)) {
            return null;
        }
        return {
            callback,
            ...(typeof parsed.optionIndex === 'number'
                ? { optionIndex: parsed.optionIndex }
                : {}),
        };
    }
    catch {
        return null;
    }
}
function readDurableQuestionCallback(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const callback = value;
    const scope = callback.scope;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope))
        return null;
    const parsedScope = scope;
    if (typeof callback.providerAlias !== 'string' ||
        !callback.providerAlias ||
        !Number.isInteger(callback.questionIndex) ||
        typeof parsedScope.appId !== 'string' ||
        !parsedScope.appId ||
        typeof parsedScope.sourceAgentFolder !== 'string' ||
        !parsedScope.sourceAgentFolder ||
        typeof parsedScope.interactionId !== 'string' ||
        !parsedScope.interactionId) {
        return null;
    }
    return callback;
}
/** Question + options, without the header (the header gets its own block). */
export function formatSlackUserQuestionBody(question) {
    const lines = [question.question, ''];
    question.options.forEach((option, optionIndex) => {
        const description = option.description
            ? ` — ${truncateSlackText(option.description, 180)}`
            : '';
        lines.push(`${optionIndex + 1}. ${option.label}${description}`);
        if (option.preview) {
            lines.push(`Preview: ${truncateSlackText(option.preview, 180)}`);
        }
    });
    if (question.multiSelect) {
        lines.push('', 'Select one or more, then tap Done.');
    }
    return lines.join('\n');
}
export function formatSlackUserQuestionPromptText(_request, question, _timeoutMs) {
    return `*${question.header}*\n${formatSlackUserQuestionBody(question)}`;
}
