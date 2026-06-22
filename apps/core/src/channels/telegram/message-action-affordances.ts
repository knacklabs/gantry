import type { MessageActionAffordance } from '../../domain/types.js';

const TELEGRAM_ACTION_CALLBACK_BY_KIND: Record<
  MessageActionAffordance['kind'],
  string
> = {
  scheduler_run_now: 'retry',
  scheduler_pause_job: 'pause',
  scheduler_open: 'open',
  live_turn_stop: 'stop',
};

export function telegramActionReplyMarkup(actions?: MessageActionAffordance[]):
  | {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    }
  | undefined {
  const buttons = (actions ?? [])
    .map((action) => {
      const code = TELEGRAM_ACTION_CALLBACK_BY_KIND[action.kind];
      if (!code || !action.label.trim()) return null;
      if (action.kind === 'live_turn_stop') {
        return {
          text: action.label.trim(),
          callback_data: `lt:stop:${action.actionToken}`,
        };
      }
      return {
        text: action.label.trim(),
        callback_data: `dl:${code}`,
      };
    })
    .filter(
      (button): button is { text: string; callback_data: string } =>
        button !== null,
    );
  if (buttons.length === 0) return undefined;
  const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> =
    [];
  for (let index = 0; index < buttons.length; index += 2) {
    inline_keyboard.push(buttons.slice(index, index + 2));
  }
  return { inline_keyboard };
}
