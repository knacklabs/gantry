import {
  PERMISSION_GLYPH,
  type PermissionPromptParts,
} from '../permission-interaction.js';
import { truncateSlackText } from './channel-user-question-utils.js';

const SLACK_HEADER_MAX = 150;
const SLACK_SECTION_MAX = 3000;

type SlackBlock = Record<string, unknown>;

/**
 * Content blocks for a permission prompt: a header (title), a section (the
 * tool-input body, which renders ``` fenced code natively in mrkdwn), a muted
 * context block (metadata + reply window), and a divider. The caller appends
 * the actions block with the decision buttons.
 */
export function buildPermissionPromptContentBlocks(
  parts: PermissionPromptParts,
): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: truncateSlackText(
          `${PERMISSION_GLYPH} ${parts.title}`,
          SLACK_HEADER_MAX,
        ),
        emoji: true,
      },
    },
  ];
  if (parts.bodyLines.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncateSlackText(parts.bodyLines.join('\n'), SLACK_SECTION_MAX),
      },
    });
  }
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: [...parts.contextLines, `Reply in ${parts.replyInMinutes}m`]
          .map(escapeSlackMrkdwnText)
          .join('\n'),
      },
    ],
  });
  blocks.push({ type: 'divider' });
  return blocks;
}

/** A completed permission decision renders as a single muted context line. */
export function buildPermissionReceiptBlocks(text: string): SlackBlock[] {
  return [
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: truncateSlackText(
            escapeSlackMrkdwnText(text),
            SLACK_SECTION_MAX,
          ),
        },
      ],
    },
  ];
}

function escapeSlackMrkdwnText(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
