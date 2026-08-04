import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPendingTelegramUserQuestion } from '@core/channels/telegram/channel-shared.js';
import type { UserQuestionRequest } from '@core/domain/types.js';
import { NO_PERMISSION_TIMEOUT_MS } from '@core/shared/permission-timeout.js';

describe('interactive channel no-timeout scheduling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not schedule or finalize a Telegram question timeout', async () => {
    vi.useFakeTimers();
    const request: UserQuestionRequest = {
      requestId: 'question-no-timeout',
      sourceAgentFolder: 'main_agent',
      questions: [
        {
          question: 'Ship now?',
          header: 'Ship',
          options: [
            { label: 'Yes', description: 'Proceed' },
            { label: 'No', description: 'Wait' },
          ],
          multiSelect: false,
        },
      ],
    };
    const pendingQuestions = new Map();
    const finalize = vi.fn(async () => undefined);
    let settled = false;
    const answer = createPendingTelegramUserQuestion({
      callbackId: 'callback-1',
      pendingKey: 'pending-1',
      request,
      question: request.questions[0]!,
      questionIndex: 0,
      chatId: '123',
      messageId: 456,
      promptText: 'Ship now?',
      promptIsHtml: false,
      timeoutMs: NO_PERMISSION_TIMEOUT_MS,
      pendingQuestions,
      callbacks: new Map(),
      finalize,
    });
    void answer.then(() => {
      settled = true;
    });

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(finalize).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    pendingQuestions.get('pending-1')?.resolve({
      selected: 'Yes',
      answeredBy: 'Ravi',
    });
    await expect(answer).resolves.toEqual({
      selected: 'Yes',
      answeredBy: 'Ravi',
    });
  });
});
