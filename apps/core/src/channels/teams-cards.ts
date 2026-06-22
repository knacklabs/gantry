import type {
  MessageActionAffordance,
  PermissionApprovalRequest,
  UserQuestionRequest,
} from '../domain/types.js';
import type { AgentTodoRender } from '../domain/ports/task-lifecycle.js';
import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../shared/permission-timeout.js';
import {
  agentTodoLines,
  countCompletedAgentTodos,
} from './agent-todo-render.js';

export { agentTodoLines } from './agent-todo-render.js';
import {
  formatPermissionPromptText,
  permissionButtonLabel,
  permissionDecisionOptions,
} from './permission-interaction.js';

export const TEAMS_ADAPTIVE_CARD_CONTENT_TYPE =
  'application/vnd.microsoft.card.adaptive';

export interface TeamsAdaptiveCardAction {
  type: 'Action.Execute';
  title: string;
  verb: string;
  data:
    | {
        action: 'permission_decision';
        requestId: string;
        decision: string;
        sourceAgentFolder: string;
        targetJid?: string;
        threadId?: string;
      }
    | {
        action: 'message_action';
        kind: 'live_turn_stop';
        actionToken: string;
        targetJid: string;
        threadId?: string;
      };
}

export interface TeamsAdaptiveCardSubmitAction {
  type: 'Action.Submit';
  title: string;
  data: {
    action: 'gantry_userq';
    requestId: string;
    sourceAgentFolder: string;
    targetJid?: string;
    threadId?: string;
  };
}

export interface TeamsAdaptiveCardPayload {
  $schema: 'http://adaptivecards.io/schemas/adaptive-card.json';
  type: 'AdaptiveCard';
  version: '1.5';
  body: Array<Record<string, unknown>>;
  actions: Array<TeamsAdaptiveCardAction | TeamsAdaptiveCardSubmitAction>;
}

export interface TeamsAdaptiveCardDescriptorPayload {
  attachments: [
    {
      contentType: typeof TEAMS_ADAPTIVE_CARD_CONTENT_TYPE;
      content: TeamsAdaptiveCardPayload;
    },
  ];
}

export function buildTeamsApprovalAdaptiveCard(
  request: PermissionApprovalRequest,
): TeamsAdaptiveCardPayload {
  const promptText = formatPermissionPromptText(
    request,
    PERMISSION_APPROVAL_TIMEOUT_MS,
  );
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        size: 'Medium',
        weight: 'Bolder',
        text: 'Permission request',
        wrap: true,
      },
      { type: 'TextBlock', text: promptText, wrap: true },
    ],
    actions: permissionDecisionOptions(request).map((mode) => ({
      type: 'Action.Execute',
      title: permissionButtonLabel(mode, request),
      verb:
        mode === 'cancel'
          ? 'gantry.permission.cancel'
          : 'gantry.permission.allow',
      data: {
        action: 'permission_decision',
        requestId: request.requestId,
        decision: mode,
        sourceAgentFolder: request.sourceAgentFolder,
        targetJid: request.targetJid,
        threadId: request.threadId,
      },
    })),
  };
}

export function buildTeamsApprovalDescriptorPayload(
  request: PermissionApprovalRequest,
): TeamsAdaptiveCardDescriptorPayload {
  return {
    attachments: [
      {
        contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
        content: buildTeamsApprovalAdaptiveCard(request),
      },
    ],
  };
}

export function buildTeamsAgentTodoCard(
  render: AgentTodoRender,
): TeamsAdaptiveCardPayload {
  const title = render.summary?.trim() ? render.summary.trim() : 'Plan';
  const done = countCompletedAgentTodos(render);
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        size: 'Medium',
        weight: 'Bolder',
        text: `📋 ${title}`,
        wrap: true,
      },
      {
        type: 'Container',
        items: agentTodoLines(render).map((line) => ({
          type: 'TextBlock',
          text: line,
          wrap: true,
        })),
      },
      {
        type: 'TextBlock',
        size: 'Small',
        isSubtle: true,
        text: `${done}/${render.items.length} done`,
        wrap: true,
      },
    ],
    actions: [],
  };
}

export function buildTeamsMessageCard(options: {
  text: string;
  targetJid: string;
  threadId?: string;
  actionAffordances?: MessageActionAffordance[];
}): TeamsAdaptiveCardPayload {
  const actions = (options.actionAffordances ?? [])
    .map((action): TeamsAdaptiveCardAction | null => {
      if (action.kind !== 'live_turn_stop' || !action.label.trim()) return null;
      return {
        type: 'Action.Execute',
        title: action.label.trim(),
        verb: 'gantry.live.stop',
        data: {
          action: 'message_action',
          kind: 'live_turn_stop',
          actionToken: action.actionToken,
          targetJid: options.targetJid,
          ...(options.threadId ? { threadId: options.threadId } : {}),
        },
      };
    })
    .filter((action): action is TeamsAdaptiveCardAction => action !== null);
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [{ type: 'TextBlock', text: options.text, wrap: true }],
    actions,
  };
}

export function buildTeamsUserQuestionCard(
  request: UserQuestionRequest,
): TeamsAdaptiveCardPayload {
  const body: Array<Record<string, unknown>> = [];
  request.questions.forEach((question, qi) => {
    if (question.header?.trim()) {
      body.push({
        type: 'TextBlock',
        size: 'Medium',
        weight: 'Bolder',
        text: question.header.trim(),
        wrap: true,
      });
    }
    body.push({ type: 'TextBlock', text: question.question, wrap: true });
    body.push({
      type: 'Input.ChoiceSet',
      id: `gantry_userq_choice_${qi}`,
      isMultiSelect: question.multiSelect === true,
      style: question.multiSelect ? 'expanded' : 'compact',
      ...(question.multiSelect ? {} : { placeholder: 'Select one' }),
      choices: question.options.map((option, oi) => ({
        title: option.description?.trim()
          ? `${option.label} — ${option.description.trim()}`
          : option.label,
        value: String(oi),
      })),
    });
    body.push({
      type: 'Input.Text',
      id: `gantry_userq_other_${qi}`,
      label: 'Other',
      placeholder: 'Type a different answer (optional)',
      isRequired: false,
    });
  });
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body,
    actions: [
      {
        type: 'Action.Submit',
        title: 'Submit',
        data: {
          action: 'gantry_userq',
          requestId: request.requestId,
          sourceAgentFolder: request.sourceAgentFolder,
          ...(request.targetJid ? { targetJid: request.targetJid } : {}),
          ...(request.threadId ? { threadId: request.threadId } : {}),
        },
      },
    ],
  };
}

export function buildTeamsUserQuestionReceiptCard(
  text: string,
): TeamsAdaptiveCardPayload {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [{ type: 'TextBlock', text, wrap: true }],
    actions: [],
  };
}
