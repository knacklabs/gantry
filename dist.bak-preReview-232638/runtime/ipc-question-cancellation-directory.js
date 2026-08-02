import { parseQuestionCancellationIpcRequest } from './ipc-parsing.js';
import { processCancellationDirectory, } from './ipc-cancellation-directory.js';
const QUESTION_CANCELLATION_LANE = 'question-cancellations';
export async function processQuestionCancellationDirectory(input) {
    return processCancellationDirectory(input, {
        requestLane: QUESTION_CANCELLATION_LANE,
        responseLane: 'user-answers',
        inFlightKind: 'user-question',
        requestIdField: 'questionRequestId',
        parser: parseQuestionCancellationIpcRequest,
        handler: input.cancelUserQuestion,
        missingHandlerErrorLabel: 'Question cancellation',
        logLabel: 'question cancellation',
    });
}
