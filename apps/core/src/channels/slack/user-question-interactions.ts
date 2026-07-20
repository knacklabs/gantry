import type { App } from '@slack/bolt';

import { resolveDurableQuestionInteractionByRequestId } from '../../application/interactions/pending-interaction-durability.js';
import type { DurableQuestionCallback } from '../../application/interactions/pending-interaction-durability.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { PendingUserQuestionState } from './channel-state.js';

type ParsedUserQuestionAction = {
  callback: DurableQuestionCallback;
  optionIndex?: number;
};

export function registerSlackUserQuestionHandlers(input: {
  app: App;
  pendingUserQuestions: Map<string, PendingUserQuestionState>;
  parseActionValue: (
    value: string | undefined,
  ) => ParsedUserQuestionAction | null;
  pendingKey: (callback: DurableQuestionCallback) => string;
  canAnswer: (
    userId: string,
    sourceAgentFolder: string,
    conversationJid: string,
  ) => Promise<boolean>;
  refreshPrompt: (pending: PendingUserQuestionState) => Promise<void>;
  finalizePrompt: (
    pending: PendingUserQuestionState,
    selection: string | string[],
    answeredBy?: string,
  ) => Promise<void>;
}): void {
  input.app.action('gantry_userq_select', async (args: any) => {
    let acknowledged = false;
    const acknowledge = async (): Promise<void> => {
      if (acknowledged) return;
      acknowledged = true;
      await args.ack();
    };
    try {
      const action = args.action as { value?: string };
      const body = args.body as {
        channel?: { id?: string };
        user?: { id?: string; name?: string; username?: string };
      };
      const parsed = input.parseActionValue(action.value);
      if (!parsed || parsed.optionIndex === undefined) return;
      const key = input.pendingKey(parsed.callback);
      const candidate = input.pendingUserQuestions.get(key);
      const pending =
        candidate && sameQuestionCallback(candidate.callback, parsed.callback)
          ? candidate
          : undefined;
      const callbackChannelId = body.channel?.id || '';
      const userId = body.user?.id || '';
      if (!userId) return;
      const answeredBy =
        body.user?.name || body.user?.username || body.user?.id || 'unknown';
      if (!pending) return;
      if (pending.settled) return;
      if (!callbackChannelId || callbackChannelId !== pending.channelId) return;
      if (
        !(await input.canAnswer(
          userId,
          pending.sourceAgentFolder,
          `sl:${pending.channelId}`,
        ))
      ) {
        try {
          await input.app.client.chat.postEphemeral({
            channel: pending.channelId,
            user: userId,
            text: 'You are not allowed to answer this prompt.',
          });
        } catch {
          // ignore
        }
        return;
      }
      if (
        parsed.optionIndex < 0 ||
        parsed.optionIndex >= pending.question.options.length
      ) {
        return;
      }
      if (!pending.question.multiSelect) {
        const label =
          pending.question.options[parsed.optionIndex]?.label?.trim() || '';
        await input.finalizePrompt(pending, label, answeredBy);
        return;
      }
      const persisted = await resolveDurableQuestionInteractionByRequestId({
        requestId: pending.requestId,
        appId: pending.callback.scope.appId,
        sourceAgentFolder: pending.sourceAgentFolder,
        questionIndex: pending.questionIndex,
        optionIndex: parsed.optionIndex,
        finalize: false,
      });
      if (!persisted) return;
      if (pending.selectedOptionIndexes.has(parsed.optionIndex)) {
        pending.selectedOptionIndexes.delete(parsed.optionIndex);
      } else {
        pending.selectedOptionIndexes.add(parsed.optionIndex);
      }
      await acknowledge();
      await input.refreshPrompt(pending);
    } finally {
      await acknowledge();
    }
  });

  input.app.action('gantry_userq_done', async (args: any) => {
    await args.ack();
    const action = args.action as { value?: string };
    const body = args.body as {
      channel?: { id?: string };
      user?: { id?: string; name?: string; username?: string };
    };
    const parsed = input.parseActionValue(action.value);
    if (!parsed) return;
    const key = input.pendingKey(parsed.callback);
    const candidate = input.pendingUserQuestions.get(key);
    const pending =
      candidate && sameQuestionCallback(candidate.callback, parsed.callback)
        ? candidate
        : undefined;
    const callbackChannelId = body.channel?.id || '';
    const userId = body.user?.id || '';
    if (!userId) return;
    const answeredBy =
      body.user?.name || body.user?.username || body.user?.id || 'unknown';
    if (!pending) return;
    if (pending.settled || !pending.question.multiSelect) return;
    if (!callbackChannelId || callbackChannelId !== pending.channelId) return;
    if (
      !(await input.canAnswer(
        userId,
        pending.sourceAgentFolder,
        `sl:${pending.channelId}`,
      ))
    ) {
      try {
        await input.app.client.chat.postEphemeral({
          channel: pending.channelId,
          user: userId,
          text: 'You are not allowed to answer this prompt.',
        });
      } catch {
        // ignore
      }
      return;
    }
    const selectedLabels = Array.from(pending.selectedOptionIndexes)
      .sort((a, b) => a - b)
      .map((index) => pending.question.options[index]?.label || '')
      .map((label) => label.trim())
      .filter((label) => label.length > 0)
      .slice(0, pending.question.options.length);
    await input.finalizePrompt(pending, selectedLabels, answeredBy);
  });

  input.app.action('gantry_userq_other', async (args: any) => {
    await args.ack();
    const action = args.action as { value?: string };
    const body = args.body as {
      channel?: { id?: string };
      user?: { id?: string };
      trigger_id?: string;
    };
    const parsed = input.parseActionValue(action.value);
    if (!parsed) return;
    const triggerId = body.trigger_id;
    if (!triggerId) return;
    const key = input.pendingKey(parsed.callback);
    const candidate = input.pendingUserQuestions.get(key);
    const pending =
      candidate && sameQuestionCallback(candidate.callback, parsed.callback)
        ? candidate
        : undefined;
    const callbackChannelId = body.channel?.id || '';
    const userId = body.user?.id || '';
    if (!userId || !callbackChannelId || pending?.settled) return;
    if (!pending || callbackChannelId !== pending.channelId) return;
    if (
      !(await input.canAnswer(
        userId,
        pending.sourceAgentFolder,
        `sl:${pending.channelId}`,
      ))
    ) {
      return;
    }
    const questionHeader = pending.question.header || 'Your answer';
    try {
      await input.app.client.views.open({
        trigger_id: triggerId,
        view: {
          type: 'modal',
          callback_id: 'gantry_userq_other_modal',
          private_metadata: JSON.stringify({
            callback: parsed.callback,
            channelId: callbackChannelId,
          }),
          title: { type: 'plain_text', text: 'Your answer' },
          submit: { type: 'plain_text', text: 'Submit' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            {
              type: 'input',
              block_id: 'gantry_userq_other_block',
              label: {
                type: 'plain_text',
                text: questionHeader.slice(0, 150),
              },
              element: {
                type: 'plain_text_input',
                action_id: 'gantry_userq_other_input',
                multiline: true,
                max_length: 3000,
                placeholder: { type: 'plain_text', text: 'Type your answer' },
              },
            },
          ],
        },
      });
    } catch (err) {
      logger.debug({ err }, 'Failed to open Slack user-question Other modal');
    }
  });

  input.app.view('gantry_userq_other_modal', async (args: any) => {
    await args.ack();
    const body = args.body as {
      user?: { id?: string; name?: string; username?: string };
    };
    const view = args.view as {
      private_metadata?: string;
      state?: {
        values?: Record<string, Record<string, { value?: string }>>;
      };
    };
    let meta: {
      callback?: DurableQuestionCallback;
      channelId?: string;
    } = {};
    try {
      meta = JSON.parse(view.private_metadata || '{}');
    } catch {
      return;
    }
    if (!meta.callback) return;
    const text = (
      view.state?.values?.['gantry_userq_other_block']?.[
        'gantry_userq_other_input'
      ]?.value || ''
    ).trim();
    if (!text) return;
    const key = input.pendingKey(meta.callback);
    const pending = input.pendingUserQuestions.get(key);
    if (pending?.settled) return;
    const userId = body.user?.id || '';
    const answeredBy =
      body.user?.name || body.user?.username || body.user?.id || 'unknown';
    if (pending && sameQuestionCallback(pending.callback, meta.callback)) {
      if (
        userId &&
        !(await input.canAnswer(
          userId,
          pending.sourceAgentFolder,
          `sl:${pending.channelId}`,
        ))
      ) {
        return;
      }
      await input.finalizePrompt(pending, text, answeredBy);
      return;
    }
  });
}

function sameQuestionCallback(
  left: DurableQuestionCallback,
  right: DurableQuestionCallback,
): boolean {
  return (
    left.providerAlias === right.providerAlias &&
    left.questionIndex === right.questionIndex &&
    left.scope.appId === right.scope.appId &&
    left.scope.sourceAgentFolder === right.scope.sourceAgentFolder &&
    left.scope.interactionId === right.scope.interactionId
  );
}
