export function teamsDeliveredQuestionIndexes(request, firstQuestionIndex) {
    return request.questions.flatMap((_, index) => index >= firstQuestionIndex ? [index] : []);
}
export function readTeamsUserQuestionSubmit(value) {
    if (!value || typeof value !== 'object')
        return null;
    const top = value;
    const candidate = top.action === 'gantry_userq'
        ? top
        : top.data && typeof top.data === 'object'
            ? top.data
            : null;
    if (!candidate || candidate.action !== 'gantry_userq')
        return null;
    const callback = readTeamsUserQuestionCallback(candidate.callback);
    if (!callback)
        return null;
    const values = {};
    for (const source of [top, candidate]) {
        for (const [key, raw] of Object.entries(source)) {
            if (key.startsWith('gantry_userq_') && typeof raw === 'string') {
                values[key] = raw;
            }
        }
    }
    return { callback, values };
}
function readTeamsUserQuestionCallback(value) {
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
export function mapTeamsUserQuestionAnswers(request, values) {
    const answers = {};
    request.questions.forEach((question, qi) => {
        const choiceRaw = (values[`gantry_userq_choice_${qi}`] || '').trim();
        const otherRaw = (values[`gantry_userq_other_${qi}`] || '').trim();
        const labels = choiceRaw
            ? choiceRaw
                .split(',')
                .map((token) => question.options[Number(token.trim())]?.label)
                .filter((label) => Boolean(label))
            : [];
        if (question.multiSelect) {
            const selected = [...labels, ...(otherRaw ? [otherRaw] : [])];
            if (selected.length > 0)
                answers[question.question] = selected;
        }
        else {
            const selected = labels[0] ?? (otherRaw || '');
            if (selected)
                answers[question.question] = selected;
        }
    });
    return answers;
}
export function formatTeamsUserQuestionReceipt(request, response) {
    const lines = request.questions
        .map((question) => {
        const answer = response.answers[question.question];
        if (answer === undefined)
            return null;
        const text = Array.isArray(answer) ? answer.join(', ') : answer;
        const label = question.header?.trim() || question.question;
        return `✅ ${label}: ${text}`;
    })
        .filter((line) => Boolean(line));
    return lines.length ? lines.join('\n') : 'Answer recorded.';
}
