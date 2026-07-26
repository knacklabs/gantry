import type {
  MemoryReviewActionDecision,
  MessageActionAffordance,
  PermissionApprovalRequest,
  PermissionCallbackScope,
  UserQuestionRequest,
} from '../domain/types.js';
import type {
  ReviewMessageSide,
  ReviewMessageView,
} from '../memory/review-message-view.js';
import type { AgentTodoRender } from '../domain/ports/task-lifecycle.js';
import type { DurableQuestionCallback } from '../application/interactions/pending-interaction-durability.js';
import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../shared/permission-timeout.js';
import {
  agentTodoLines,
  agentTodoStopActions,
  countCompletedAgentTodos,
  formatAgentProgressLine,
  formatAgentTodoHeader,
  hasAgentTodoCardHeader,
} from './agent-todo-render.js';

export { agentTodoLines } from './agent-todo-render.js';
import {
  formatPermissionPromptText,
  permissionButtonLabel,
  permissionDecisionOptions,
} from './permission-interaction.js';

export const TEAMS_ADAPTIVE_CARD_CONTENT_TYPE =
  'application/vnd.microsoft.card.adaptive';
const GENERIC_ATTACHMENT_UNAVAILABLE_LINE = '- Attachment unavailable';
const TEAMS_ATTACHMENT_UNAVAILABLE_LINE =
  '- Attachment unavailable in Teams until signed artifact links are added.';

export interface TeamsAdaptiveCardAction {
  type: 'Action.Execute';
  title: string;
  verb: string;
  data:
    | {
        action: 'permission_decision';
        callback: {
          providerAlias: string;
          scope: PermissionCallbackScope;
          matchKind: 'individual' | 'batch';
        };
        decision: string;
      }
    | {
        action: 'message_action';
        kind: 'live_turn_stop';
        actionToken: string;
        targetJid: string;
        threadId?: string;
      }
    | {
        action: 'message_action';
        kind: 'scheduler_run_now';
        jobId: string;
        targetJid: string;
        threadId?: string;
      }
    | {
        action: 'message_action';
        kind: 'memory_review_decision';
        reviewId: string;
        decision: MemoryReviewActionDecision;
        targetJid: string;
        threadId?: string;
      };
}

export interface TeamsAdaptiveCardSubmitAction {
  type: 'Action.Submit';
  title: string;
  data: {
    action: 'gantry_userq';
    callback: DurableQuestionCallback;
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

export function formatTeamsAttachmentUnavailableCopy(
  text: string,
  filesPresent = false,
): string {
  let inAttachments = false;
  return text
    .split('\n')
    .map((line) => {
      if (line === 'Attachments:') {
        inAttachments = true;
        return line;
      }
      if (
        inAttachments &&
        ((filesPresent && line.startsWith('- ')) ||
          line === GENERIC_ATTACHMENT_UNAVAILABLE_LINE ||
          line.startsWith(`${GENERIC_ATTACHMENT_UNAVAILABLE_LINE}: `))
      ) {
        return TEAMS_ATTACHMENT_UNAVAILABLE_LINE;
      }
      if (inAttachments && line !== '' && !line.startsWith('- ')) {
        inAttachments = false;
      }
      return line;
    })
    .join('\n');
}

export function buildTeamsApprovalAdaptiveCard(
  request: PermissionApprovalRequest,
  callback = {
    providerAlias: globalThis.crypto.randomUUID(),
    scope: {
      appId: request.appId || 'default',
      sourceAgentFolder: request.sourceAgentFolder,
      interactionId: request.requestId,
    },
    matchKind: request.permissionBatch
      ? ('batch' as const)
      : ('individual' as const),
  },
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
        callback,
        decision: mode,
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
  targetJid = '',
): TeamsAdaptiveCardPayload {
  if (render.cardKind === 'progress') {
    return {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.5',
      body: [
        {
          type: 'TextBlock',
          text: formatAgentProgressLine(render),
          wrap: true,
        },
      ],
      actions: [],
    };
  }
  const title = formatAgentTodoHeader(render);
  const heading = hasAgentTodoCardHeader(render) ? title : `📋 ${title}`;
  const done = countCompletedAgentTodos(render);
  const stopAction = agentTodoStopActions(render)?.[0];
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        size: 'Medium',
        weight: 'Bolder',
        text: heading,
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
    actions:
      stopAction?.kind === 'live_turn_stop'
        ? [
            {
              type: 'Action.Execute',
              title: stopAction.label,
              verb: 'gantry.live.stop',
              data: {
                action: 'message_action',
                kind: 'live_turn_stop',
                actionToken: stopAction.actionToken,
                targetJid,
                ...(render.threadId ? { threadId: render.threadId } : {}),
              },
            },
          ]
        : [],
  };
}

export function buildTeamsMessageCard(options: {
  text: string;
  targetJid: string;
  threadId?: string;
  actionOnly?: boolean;
  actionAffordances?: MessageActionAffordance[];
}): TeamsAdaptiveCardPayload {
  const actions = (options.actionAffordances ?? [])
    .map((action): TeamsAdaptiveCardAction | null => {
      if (!action.label.trim()) return null;
      if (action.kind === 'live_turn_stop') {
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
      }
      if (action.kind === 'scheduler_run_now' && action.jobId.trim()) {
        // ponytail: only scheduler_run_now is wired here; add pause/open when they share a callback path.
        return {
          type: 'Action.Execute',
          title: action.label.trim(),
          verb: 'gantry.scheduler.run_now',
          data: {
            action: 'message_action',
            kind: 'scheduler_run_now',
            jobId: action.jobId,
            targetJid: options.targetJid,
            ...(options.threadId ? { threadId: options.threadId } : {}),
          },
        };
      }
      return null;
    })
    .filter((action): action is TeamsAdaptiveCardAction => action !== null);
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: options.actionOnly
      ? []
      : [{ type: 'TextBlock', text: options.text, wrap: true }],
    actions,
  };
}

export function buildTeamsUserQuestionCard(
  request: UserQuestionRequest,
  callback: DurableQuestionCallback,
  startIndex = 0,
): TeamsAdaptiveCardPayload {
  const body: Array<Record<string, unknown>> = [];
  request.questions.forEach((question, qi) => {
    if (qi < startIndex) return;
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
          callback,
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

// A memory-review outcome (receipt) is just a text-only card with no actions —
// identical in shape to the user-question receipt, so reuse it.
export const buildTeamsReviewReceiptCard = buildTeamsUserQuestionReceiptCard;

/**
 * Neutralize dynamic snapshot text before embedding it in an Adaptive Card
 * TextBlock (Teams renders a markdown subset). Backslash-escaping the link
 * syntax `[ ] ( )`, the code backtick, and the angle brackets means captured
 * memory can't inject a live link, code span, or a `<at>` mention. Mirrors the
 * intent of the Slack mrkdwn / Telegram HTML escaping in T5. Emphasis chars
 * (`_`/`*`) are intentionally left alone so common keys like `coffee_order`
 * render cleanly — they carry no injection risk.
 */
function escapeTeamsCardText(value: string): string {
  return value.replace(/[\\<>[\]()`]/g, '\\$&');
}

function teamsSideFact(side: ReviewMessageSide): {
  title: string;
  value: string;
} {
  const meta = [side.source, side.date]
    .filter(Boolean)
    .map((part) => escapeTeamsCardText(part as string))
    .join(' · ');
  const value = `"${escapeTeamsCardText(side.value)}"`;
  return {
    title: escapeTeamsCardText(side.label),
    value: meta ? `${value} — ${meta}` : value,
  };
}

/**
 * Compact-structured Adaptive Card for a memory-review message. Mirrors the
 * Slack/Telegram T5 renderers from the same provider-neutral ReviewMessageView:
 *   - title TextBlock
 *   - FactSet: Topic + each side (value with its "source · date") so a reviewer
 *     sees WHAT the conflict is (both sides + recency) at a glance
 *   - Change/Why container so they see WHAT will change plainly
 *   - bounded evidence (already capped/truncated in the view) as a small subtle
 *     container — never the full text
 *   - three Action.Execute buttons carrying the memory_review_decision payload
 *     + targetJid so inbound validation rejects foreign-chat callbacks
 * All snapshot-sourced values are escaped for the TextBlock markdown subset.
 */
export function teamsReviewCard(
  view: ReviewMessageView,
  options: { targetJid: string; threadId?: string },
): TeamsAdaptiveCardPayload {
  const body: Array<Record<string, unknown>> = [
    {
      type: 'TextBlock',
      size: 'Medium',
      weight: 'Bolder',
      text: escapeTeamsCardText(view.title),
      wrap: true,
    },
    {
      type: 'FactSet',
      facts: [
        { title: 'Topic', value: escapeTeamsCardText(view.topic) },
        ...view.sides.map(teamsSideFact),
      ],
    },
    {
      type: 'Container',
      items: [
        {
          type: 'TextBlock',
          text: `**Change →** ${escapeTeamsCardText(view.change)}`,
          wrap: true,
        },
        {
          type: 'TextBlock',
          text: `**Why:** ${escapeTeamsCardText(view.why)}`,
          wrap: true,
          isSubtle: true,
        },
      ],
    },
  ];
  if (view.evidence.length > 0) {
    // ponytail: bounded subtle container; the view already caps to 3 short
    // snippets, so no ToggleVisibility needed — add one if evidence grows.
    body.push({
      type: 'Container',
      items: view.evidence.map((item) => ({
        type: 'TextBlock',
        size: 'Small',
        isSubtle: true,
        wrap: true,
        text: `📎 ${escapeTeamsCardText([item.source, item.date].filter(Boolean).join(' · '))}: ${escapeTeamsCardText(item.snippet)}`,
      })),
    });
  }
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body,
    actions: view.affordances.map((affordance) => ({
      type: 'Action.Execute',
      title: affordance.label,
      verb: 'gantry.memory.review',
      data: {
        action: 'message_action',
        kind: 'memory_review_decision',
        reviewId: affordance.reviewId,
        decision: affordance.decision,
        targetJid: options.targetJid,
        ...(options.threadId ? { threadId: options.threadId } : {}),
      },
    })),
  };
}
