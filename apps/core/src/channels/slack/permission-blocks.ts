import {
  PERMISSION_GLYPH,
  type PermissionPromptFullView,
  type PermissionPromptParts,
} from '../permission-interaction.js';
import { escapeMarkdownFenceDelimiters } from '../permission-fenced-content.js';
import { truncateSlackText } from './channel-user-question-utils.js';

const SLACK_HEADER_MAX = 150;
const SLACK_SECTION_MAX = 3000;

type SlackBlock = Record<string, unknown>;

/**
 * Content blocks for a permission prompt: a header (title), a section (the
 * tool-input body, which renders ``` fenced code natively in mrkdwn), a muted
 * context block (why, agent and context), and a divider. The caller appends
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
    for (const sectionText of chunkSlackSectionText(parts.bodyLines)) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: sectionText,
        },
      });
    }
  }
  if (parts.contextLines.length > 0) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: parts.contextLines.map(escapeSlackMrkdwnText).join('\n'),
        },
      ],
    });
  }
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

export function buildPermissionFullViewModalBlocks(
  fullView: PermissionPromptFullView,
): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  const content = escapeMarkdownFenceDelimiters(fullView.content);
  const marker = fullView.filename.endsWith('.diff')
    ? '```diff'
    : fullView.filename.endsWith('.yaml')
      ? '```yaml'
      : '```';
  for (const chunk of chunkSlackFencedSectionText(marker, [content])) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: chunk },
    });
  }
  return blocks.length > 0
    ? blocks
    : [{ type: 'section', text: { type: 'mrkdwn', text: '_No details._' } }];
}

function chunkSlackSectionText(lines: string[]): string[] {
  const chunks: string[] = [];
  let plainLines: string[] = [];
  let fenceMarker: string | null = null;
  let fenceLines: string[] = [];

  const flushPlain = () => {
    chunks.push(...chunkSlackPlainSectionText(plainLines));
    plainLines = [];
  };
  const flushFence = () => {
    if (!fenceMarker) return;
    flushPlain();
    chunks.push(...chunkSlackFencedSectionText(fenceMarker, fenceLines));
    fenceMarker = null;
    fenceLines = [];
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (fenceMarker) {
        flushFence();
      } else {
        flushPlain();
        fenceMarker = line;
        fenceLines = [];
      }
      continue;
    }
    if (fenceMarker) {
      fenceLines.push(line);
    } else {
      plainLines.push(line);
    }
  }
  flushFence();
  flushPlain();
  return chunks;
}

function chunkSlackPlainSectionText(lines: string[]): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    if (line.length > SLACK_SECTION_MAX) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let offset = 0; offset < line.length; offset += SLACK_SECTION_MAX) {
        chunks.push(line.slice(offset, offset + SLACK_SECTION_MAX));
      }
      continue;
    }
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= SLACK_SECTION_MAX) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    current = line;
  }
  if (current) chunks.push(current);
  return chunks;
}

function chunkSlackFencedSectionText(
  marker: string,
  lines: string[],
): string[] {
  const content = lines.join('\n');
  const close = '```';
  const budget = Math.max(
    1,
    SLACK_SECTION_MAX - marker.length - close.length - 2,
  );
  if (!content) return [`${marker}\n${close}`];
  const chunks: string[] = [];
  for (let offset = 0; offset < content.length; offset += budget) {
    chunks.push(
      `${marker}\n${content.slice(offset, offset + budget)}\n${close}`,
    );
  }
  return chunks;
}

function escapeSlackMrkdwnText(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
