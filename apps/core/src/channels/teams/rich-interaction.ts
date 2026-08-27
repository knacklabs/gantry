import type { RichInteractionRequest } from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { TEAMS_ADAPTIVE_CARD_CONTENT_TYPE } from './cards.js';
import {
  teamsConversationIdFromJid,
  type TeamsSdkClient,
} from './types.js';
import {
  richDescriptor,
  RICH_INTERACTION_FALLBACK_COPY,
  RICH_INTERACTION_SUBMIT_LABEL,
  richFallbackText,
  richFormFields,
  richTextLines,
} from '../rich-interaction.js';

export function buildTeamsRichInteractionPayload(
  input: RichInteractionRequest,
): {
  attachments: [{ contentType: string; content: Record<string, unknown> }];
} {
  const item = richDescriptor(input);
  const fields = richFormFields(input);
  const body: Record<string, unknown>[] = richTextLines(input).map(
    (line, index) => ({
      type: 'TextBlock',
      text: line,
      wrap: true,
      ...(index === 0 ? { size: 'Medium', weight: 'Bolder' } : {}),
    }),
  );
  if (fields.length) {
    body.push(
      ...fields.map((field, index) => ({
        type: 'Input.Text',
        id: String(field.id || `field_${index}`),
        label: String(field.label || field.id || `Field ${index + 1}`),
        isMultiline: field.type === 'textarea',
        isRequired: field.required === true,
      })),
    );
  }
  const actions: Record<string, unknown>[] = (item.actions ?? [])
    .slice(0, 5)
    .map((action) => ({
      type: action.kind === 'submit' ? 'Action.Submit' : 'Action.Execute',
      title: action.label,
      verb: 'gantry.rich.action',
      data: {
        action: 'rich_interaction',
        interactionId: item.id,
        actionId: action.id,
      },
    }));
  if (fields.length) {
    actions.push({
      type: 'Action.Submit',
      title: RICH_INTERACTION_SUBMIT_LABEL,
      verb: 'gantry.rich.form.submit',
      data: {
        action: 'rich_form_submit',
        interactionId: item.id,
      },
    });
  }
  return {
    attachments: [
      {
        contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.5',
          body,
          actions,
        },
      },
    ],
  };
}

export async function renderTeamsRichInteraction(input: {
  sdkClient: TeamsSdkClient;
  jid: string;
  render: RichInteractionRequest;
  sendFallback: (
    text: string,
    options: { threadId?: string },
  ) => Promise<unknown>;
}): Promise<boolean> {
  const { sdkClient, jid, render, sendFallback } = input;
  const conversationId = teamsConversationIdFromJid(jid);
  if (!conversationId) return false;
  const payload = buildTeamsRichInteractionPayload(render);
  try {
    if (sdkClient.sendAdaptiveCard) {
      await sdkClient.sendAdaptiveCard({
        conversationId,
        card: payload.attachments[0].content as never,
        ...(render.threadId ? { threadId: render.threadId } : {}),
      });
    } else {
      await sdkClient.sendMessage({
        conversationId,
        text: '',
        attachments: payload.attachments,
        ...(render.threadId ? { threadId: render.threadId } : {}),
      } as never);
    }
    return true;
  } catch (err) {
    logger.warn({ jid, err }, 'Teams rich interaction render failed');
    await sendFallback(
      `${RICH_INTERACTION_FALLBACK_COPY}\n\n${richFallbackText(render)}`,
      { threadId: render.threadId },
    );
    return true;
  }
}
