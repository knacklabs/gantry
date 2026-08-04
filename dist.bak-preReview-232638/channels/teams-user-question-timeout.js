export function buildTeamsQuestionTimeoutAnswers(request, startIndex) {
    const remainingQuestionIndexes = request.questions.flatMap((_, index) => index >= startIndex ? [index] : []);
    const timeoutAnswers = Object.fromEntries(remainingQuestionIndexes.map((questionIndex) => {
        const question = request.questions[questionIndex];
        return [question.question, question.multiSelect ? [] : ''];
    }));
    return { remainingQuestionIndexes, timeoutAnswers };
}
