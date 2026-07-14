import type {
  MessageSendOptions,
  PermissionApprovalDecisionMode,
  ProgressUpdateOptions,
  UserQuestionRequest,
} from '../domain/types.js';

export const LIVE_STOP_CUSTOM_ID_PREFIX = 'gantry:live_stop:';
export const SCHEDULER_RUN_NOW_CUSTOM_ID_PREFIX = 'gantry:scheduler_run_now:';
export const PERMISSION_CUSTOM_ID_PREFIX = 'gantry:perm:';
export const QUESTION_CUSTOM_ID_PREFIX = 'gantry:q:';
const DISCORD_CUSTOM_ID_MAX_LENGTH = 100;

export function discordActionComponents(
  options?: MessageSendOptions | ProgressUpdateOptions,
) {
  const stopAction = options?.actionAffordances?.find(
    (action) => action.kind === 'live_turn_stop',
  );
  const runNowAction = options?.actionAffordances?.find(
    (action) => action.kind === 'scheduler_run_now' && action.jobId.trim(),
  );
  const buttons: Array<{ label: string; style: number; custom_id: string }> =
    [];
  if (stopAction?.kind === 'live_turn_stop') {
    buttons.push({
      style: 4,
      label: stopAction.label,
      custom_id: `${LIVE_STOP_CUSTOM_ID_PREFIX}${stopAction.actionToken}`,
    });
  }
  if (runNowAction?.kind === 'scheduler_run_now') {
    // ponytail: only scheduler_run_now is wired here; add pause/open when they share a callback path.
    const customId = `${SCHEDULER_RUN_NOW_CUSTOM_ID_PREFIX}${encodeURIComponent(runNowAction.jobId)}`;
    if (customId.length <= DISCORD_CUSTOM_ID_MAX_LENGTH) {
      buttons.push({
        style: 1,
        label: runNowAction.label,
        custom_id: customId,
      });
    }
  }
  return buttons.length ? buttonRows(buttons) : undefined;
}

export function buttonRows(
  buttons: Array<{
    label: string;
    style: number;
    custom_id: string;
  }>,
): unknown[] {
  const rows = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push({
      type: 1,
      components: buttons.slice(index, index + 5).map((button) => ({
        type: 2,
        ...button,
      })),
    });
  }
  return rows;
}

export function questionComponents(
  request: UserQuestionRequest,
  questionIndex: number,
): unknown[] {
  const question = request.questions[questionIndex]!;
  const buttons = question.options
    .slice(0, question.multiSelect ? 4 : 5)
    .map((option, optionIndex) => ({
      label: option.label.slice(0, 80),
      style: 1,
      custom_id: questionCustomId(
        request.requestId,
        questionIndex,
        optionIndex,
      ),
    }));
  if (question.multiSelect) {
    buttons.push({
      label: 'Done',
      style: 3,
      custom_id: questionDoneCustomId(request.requestId, questionIndex),
    });
  }
  return buttonRows(buttons);
}

export function permissionCustomId(
  requestId: string,
  mode: PermissionApprovalDecisionMode,
): string {
  return `${PERMISSION_CUSTOM_ID_PREFIX}${encodeURIComponent(requestId)}:${mode}`;
}

export function parsePermissionCustomId(
  customId: string,
): { requestId: string; mode: PermissionApprovalDecisionMode } | null {
  const raw = customId.slice(PERMISSION_CUSTOM_ID_PREFIX.length);
  const separator = raw.lastIndexOf(':');
  if (separator <= 0) return null;
  const mode = raw.slice(separator + 1) as PermissionApprovalDecisionMode;
  if (!['allow_once', 'allow_persistent_rule', 'cancel'].includes(mode)) {
    return null;
  }
  return {
    requestId: decodeURIComponent(raw.slice(0, separator)),
    mode,
  };
}

export function questionCustomId(
  requestId: string,
  questionIndex: number,
  optionIndex: number,
): string {
  return `${QUESTION_CUSTOM_ID_PREFIX}${encodeURIComponent(requestId)}:${questionIndex}:${optionIndex}`;
}

export function questionDoneCustomId(
  requestId: string,
  questionIndex: number,
): string {
  return questionCustomId(requestId, questionIndex, -1);
}

export function parseQuestionCustomId(
  customId: string,
): { requestId: string; questionIndex: number; optionIndex: number } | null {
  const raw = customId.slice(QUESTION_CUSTOM_ID_PREFIX.length);
  const parts = raw.split(':');
  if (parts.length < 3) return null;
  const optionIndex = Number.parseInt(parts.pop() || '', 10);
  const questionIndex = Number.parseInt(parts.pop() || '', 10);
  if (!Number.isInteger(questionIndex) || !Number.isInteger(optionIndex)) {
    return null;
  }
  return {
    requestId: decodeURIComponent(parts.join(':')),
    questionIndex,
    optionIndex,
  };
}
