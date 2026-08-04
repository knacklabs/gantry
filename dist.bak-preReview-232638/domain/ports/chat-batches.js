export const CHAT_BATCH_STATES = [
    'submission_intent',
    'preflight_failed',
    'submission_unknown',
    'submitted',
    'processing',
    'applied',
    'failed',
    'abandoned',
];
export class ChatBatchDailyCostLimitError extends Error {
    constructor() {
        super('Chat batch daily cost limit would be exceeded');
        this.name = 'ChatBatchDailyCostLimitError';
    }
}
