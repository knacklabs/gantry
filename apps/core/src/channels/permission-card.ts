import type { PermissionCardMessageView } from '../domain/permission-card.js';
import {
  buildPermissionPromptParts,
  formatPermissionPromptPartsText,
  type PermissionPromptParts,
} from './permission-interaction.js';

const PERMISSION_CARD_TIMEOUT_MS = 24 * 60 * 60_000;
const PERMISSION_CARD_TEXT_BUDGET = 1_600;
const PERMISSION_CARD_FULL_VIEW_BUDGET = 500;
const PERMISSION_CARD_TITLE_BUDGET = 200;
const OVERFLOW_NOTICE =
  'Open the pending approvals list to review the remaining details.';
const FULL_VIEW_OVERFLOW_SUFFIX = `\n…\n${OVERFLOW_NOTICE}`;

export interface BoundedPermissionCard {
  parts: PermissionPromptParts;
  text: string;
  fullViewAvailable: boolean;
}

export function buildBoundedPermissionCard(
  view: PermissionCardMessageView,
): BoundedPermissionCard {
  const source = buildPermissionPromptParts(
    view.request,
    PERMISSION_CARD_TIMEOUT_MS,
  );
  const fullView = view.fullView ?? source.fullView;
  const boundedFullView = fullView
    ? {
        ...fullView,
        label: fullView.label.slice(0, 80),
        title: fullView.title.slice(0, 150),
        filename: fullView.filename.slice(0, 120),
        content:
          fullView.content.length <= PERMISSION_CARD_FULL_VIEW_BUDGET
            ? fullView.content
            : `${fullView.content
                .slice(
                  0,
                  PERMISSION_CARD_FULL_VIEW_BUDGET -
                    FULL_VIEW_OVERFLOW_SUFFIX.length,
                )
                .trimEnd()}${FULL_VIEW_OVERFLOW_SUFFIX}`,
      }
    : undefined;
  const title = source.title.slice(0, PERMISSION_CARD_TITLE_BUDGET);
  const bodyLines: string[] = [];
  const contextLines: string[] = [];
  // A truncated title IS overflow: the owner must know the pending list
  // holds the full text (review R3).
  let overflowed = source.title.length > PERMISSION_CARD_TITLE_BUDGET;
  for (const [kind, line] of [
    ...source.bodyLines.map((value) => ['body', value] as const),
    ...source.contextLines.map((value) => ['context', value] as const),
  ]) {
    const candidate = {
      ...source,
      title,
      bodyLines: kind === 'body' ? [...bodyLines, line] : bodyLines,
      contextLines: kind === 'context' ? [...contextLines, line] : contextLines,
      fullView: undefined,
    };
    if (
      formatPermissionPromptPartsText(candidate).length >
      PERMISSION_CARD_TEXT_BUDGET
    ) {
      overflowed = true;
      break;
    }
    if (kind === 'body') bodyLines.push(line);
    else contextLines.push(line);
  }
  if (
    overflowed ||
    (fullView && fullView.content !== boundedFullView?.content)
  ) {
    while (
      formatPermissionPromptPartsText({
        ...source,
        title,
        bodyLines: [...bodyLines, OVERFLOW_NOTICE],
        contextLines,
        fullView: undefined,
      }).length > PERMISSION_CARD_TEXT_BUDGET
    ) {
      if (contextLines.length > 0) contextLines.pop();
      else if (bodyLines.length > 0) bodyLines.pop();
      else break;
    }
    bodyLines.push(OVERFLOW_NOTICE);
  }
  const parts = {
    ...source,
    title,
    bodyLines,
    contextLines,
    fullView: boundedFullView,
  };
  return {
    parts,
    text: formatPermissionPromptPartsText({ ...parts, fullView: undefined }),
    fullViewAvailable: Boolean(fullView),
  };
}

export function permissionCardCallback(view: PermissionCardMessageView): {
  providerAlias: string;
  scope: {
    appId: string;
    sourceAgentFolder: string;
    interactionId: string;
  };
  matchKind: 'individual' | 'batch';
} {
  return {
    providerAlias: view.providerAlias,
    scope: {
      appId: view.request.appId || 'default',
      sourceAgentFolder: view.request.sourceAgentFolder,
      interactionId: view.request.requestId,
    },
    matchKind: view.request.permissionBatch ? 'batch' : 'individual',
  };
}
