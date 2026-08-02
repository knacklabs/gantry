import { randomUUID } from 'node:crypto';

import { findConversationRoutesForChat } from '../../shared/thread-queue-key.js';
import {
  processMemoryReviewDecisionRequest,
  resolveReviewSubjectWithinBoundary,
} from '../../memory/memory-review-ipc.js';
import { resolveTrustedMemorySubject } from '../../memory/memory-ipc.js';
import type { ChannelWiring } from './channel-wiring-types.js';
import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import type {
  ConversationRoute,
  MemoryReviewMessageActionInput,
  MessageActionOutcome,
} from '../../domain/types.js';

/**
 * Execute a channel-initiated memory-review decision.
 *
 * The channel supplies AUTHENTICATED provider identity + conversation; it never
 * supplies authority. This handler resolves the source agent, requires a
 * same-channel control approver, then hands the decision to the trusted
 * executor. Authority + the stale/withdrawn veto live in the executor's DB path
 * (conditional pending_review claim), not here.
 */
const DECISION_SOURCE = 'channel_action';

type DecisionState = 'applied' | 'stale' | 'invalid';

export interface MemoryReviewDecisionExecuteInput {
  reviewId: string;
  decision: 'approve' | 'reject';
  reviewerId: string;
  appId: string;
  sourceAgentFolder: string;
  conversationJid: string;
}

export interface MemoryReviewMessageActionDeps {
  appId: string;
  sourceAgentFolderFor: (
    conversationJid: string,
    threadId?: string,
    providerAccountId?: string,
  ) => string | undefined;
  isControlApproverAllowed: ChannelWiring['isControlApproverAllowed'];
  execute: (
    input: MemoryReviewDecisionExecuteInput,
  ) => Promise<{ state: DecisionState; receipt: string }>;
}

export async function handleMemoryReviewDecisionAction(
  deps: MemoryReviewMessageActionDeps,
  action: MemoryReviewMessageActionInput,
): Promise<MessageActionOutcome> {
  if (!action.userId) {
    return {
      state: 'invalid',
      receipt: 'Missing an authenticated user for this review decision.',
    };
  }
  const sourceAgentFolder = deps.sourceAgentFolderFor(
    action.conversationJid,
    action.threadId,
    action.providerAccountId,
  );
  if (!sourceAgentFolder) {
    return {
      state: 'invalid',
      receipt: 'This review is not associated with this conversation.',
    };
  }
  const allowed = await deps.isControlApproverAllowed({
    conversationJid: action.conversationJid,
    ...(action.providerAccountId
      ? { providerAccountId: action.providerAccountId }
      : {}),
    userId: action.userId,
    sourceAgentFolder,
    decisionPolicy: 'same_channel',
  });
  if (!allowed) {
    return {
      state: 'denied',
      receipt: 'Not authorized to decide this review in this channel.',
    };
  }
  if (action.decision === 'edit') {
    // Buttons only initiate the edit; text-entry lands in a later task.
    return {
      state: 'needs_input',
      receipt: `Reply: edit memory review ${action.reviewId}: <replacement> — <reason>`,
      replacementText: `edit memory review ${action.reviewId}: `,
      clearActions: false,
    };
  }
  const result = await deps.execute({
    reviewId: action.reviewId,
    decision: action.decision,
    reviewerId: action.userId,
    appId: deps.appId,
    sourceAgentFolder,
    conversationJid: action.conversationJid,
  });
  return { state: result.state, receipt: result.receipt };
}

function getSourceAgentFolder(
  routes: Record<string, ConversationRoute>,
  conversationJid: string,
  threadId?: string,
  providerAccountId?: string,
): string | undefined {
  const folders = new Set(
    findConversationRoutesForChat(
      routes,
      conversationJid,
      threadId,
      providerAccountId,
    ).map(([, route]) => route.folder),
  );
  return folders.size === 1 ? folders.values().next().value : undefined;
}

export async function executeMemoryReviewDecision(
  input: MemoryReviewDecisionExecuteInput,
): Promise<{ state: DecisionState; receipt: string }> {
  // appId/agentId are the channel-bound boundary; subjectType/subjectId are
  // discarded — the review's OWN subject (below) is authoritative, never the
  // approver's identity.
  const boundary = resolveTrustedMemorySubject(input.sourceAgentFolder, {
    appId: input.appId,
    agentId: agentIdForFolder(input.sourceAgentFolder),
    personId: input.reviewerId,
  });
  try {
    // Lookup lives inside the error boundary: a DB failure here maps to a
    // controlled 'invalid', not an unhandled rejection out of the channel API.
    const subject = await resolveReviewSubjectWithinBoundary({
      appId: boundary.appId,
      agentId: boundary.agentId,
      reviewId: input.reviewId,
    });
    if (!subject) {
      return { state: 'invalid', receipt: 'This review could not be found.' };
    }
    const request = {
      requestId: `memory-review-decision-${randomUUID()}`,
      action: 'memory_review_decision' as const,
      payload: {
        review_id: input.reviewId,
        decision: input.decision,
        decision_source: DECISION_SOURCE,
      },
      // reviewerId is the approver's audit/authorization identity only.
      context: { personId: input.reviewerId, reviewerIsControlApprover: true },
    };
    const response = await processMemoryReviewDecisionRequest({
      request,
      subject,
    });
    const review = (response.data as { review?: unknown } | undefined)?.review;
    if (!review) {
      return { state: 'invalid', receipt: 'This review could not be found.' };
    }
    return {
      state: 'applied',
      receipt:
        input.decision === 'approve'
          ? 'Memory review approved.'
          : 'Memory review rejected.',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (/pending memory review not found/i.test(message)) {
      return { state: 'stale', receipt: 'This review is no longer pending.' };
    }
    return { state: 'invalid', receipt: 'This review could not be decided.' };
  }
}

export function registerRuntimeMemoryReviewMessageAction(
  channelWiring: ChannelWiring,
  app: { getConversationRoutes(): Record<string, ConversationRoute> },
): void {
  const deps: MemoryReviewMessageActionDeps = {
    appId: String(channelWiring.getRuntimeAppId()),
    sourceAgentFolderFor: (conversationJid, threadId, providerAccountId) =>
      getSourceAgentFolder(
        app.getConversationRoutes(),
        conversationJid,
        threadId,
        providerAccountId,
      ),
    isControlApproverAllowed: channelWiring.isControlApproverAllowed,
    execute: executeMemoryReviewDecision,
  };
  channelWiring.setMemoryReviewMessageActionHandler((action) =>
    handleMemoryReviewDecisionAction(deps, action),
  );
}
