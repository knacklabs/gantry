import fs from 'fs';
import { hasIpcRequestClaimMarker, ipcQuestionWaitExpiredReason, } from '../../../shared/ipc-interaction-lifetime.js';
import { nowMs, sleep } from '../../../shared/time/datetime.js';
import { truncateText } from '../formatting.js';
import { hasValidIpcResponseSignature } from '../ipc.js';
import { CANCELLED_QUESTION_REASON, writeUserQuestionCancellation as cancelUserQuestionRequest, } from './user-question-cancellation.js';
export const USER_QUESTION_TIMEOUT_MS = 5 * 60 * 1000;
export const USER_QUESTION_POLL_INTERVAL_MS = 100;
const USER_QUESTION_MAX_ANSWER_LENGTH = 500;
const USER_QUESTION_MAX_ANSWERED_BY_LENGTH = 120;
export async function sleepWithAbort(ms, signal) {
    if (!signal) {
        await sleep(ms);
        return false;
    }
    if (signal.aborted)
        return true;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve(false);
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            resolve(true);
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
export async function waitForUserQuestionResponse(input) {
    const deadline = input.permissionLane === 'autonomous'
        ? nowMs() + USER_QUESTION_TIMEOUT_MS
        : Date.parse(String(input.authExpiresAt));
    for (let requestClaimed = false;;) {
        if (!requestClaimed && input.permissionLane === 'interactive') {
            requestClaimed = hasIpcRequestClaimMarker(input.requestPath, input.claimProbe);
        }
        if (!requestClaimed && nowMs() >= deadline)
            break;
        if (input.signal?.aborted) {
            cancelUserQuestionRequest(input);
            return {
                content: [{ type: 'text', text: CANCELLED_QUESTION_REASON }],
            };
        }
        if (fs.existsSync(input.responsePath)) {
            try {
                const raw = JSON.parse(fs.readFileSync(input.responsePath, 'utf-8'));
                fs.unlinkSync(input.responsePath);
                const payload = {
                    requestId: input.requestId,
                    answers: raw?.answers && typeof raw.answers === 'object' ? raw.answers : {},
                    ...(typeof raw?.answeredBy === 'string' && raw.answeredBy.trim()
                        ? { answeredBy: raw.answeredBy }
                        : {}),
                };
                if (raw.requestId !== input.requestId) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: 'Answer request id mismatch.',
                            },
                        ],
                    };
                }
                if (!hasValidIpcResponseSignature(raw, payload)) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: 'Answer verification failed.',
                            },
                        ],
                    };
                }
                if (raw?.answers && typeof raw.answers === 'object') {
                    const lines = [];
                    for (const [question, answer] of Object.entries(raw.answers)) {
                        const normalizedAnswer = Array.isArray(answer)
                            ? answer.map((item) => String(item)).join(', ')
                            : String(answer);
                        lines.push(`${question}: ${truncateText(normalizedAnswer, USER_QUESTION_MAX_ANSWER_LENGTH)}`);
                    }
                    if (typeof raw.answeredBy === 'string' && raw.answeredBy.trim()) {
                        lines.push(`(answered by ${truncateText(raw.answeredBy.trim(), USER_QUESTION_MAX_ANSWERED_BY_LENGTH)})`);
                    }
                    return {
                        content: [
                            {
                                type: 'text',
                                text: lines.join('\n') || 'No answer received.',
                            },
                        ],
                    };
                }
            }
            catch {
                return {
                    content: [{ type: 'text', text: 'Failed to read answer.' }],
                };
            }
        }
        const aborted = await sleepWithAbort(USER_QUESTION_POLL_INTERVAL_MS, input.signal);
        if (aborted) {
            cancelUserQuestionRequest(input);
            return {
                content: [{ type: 'text', text: CANCELLED_QUESTION_REASON }],
            };
        }
    }
    fs.rmSync(input.requestPath, { force: true });
    return {
        content: [
            {
                type: 'text',
                text: ipcQuestionWaitExpiredReason(input.permissionLane),
            },
        ],
    };
}
