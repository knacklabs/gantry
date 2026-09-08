import type { AgentId } from '../domain/agent/agent.js';
import type { AppId } from '../domain/app/app.js';
import { logger } from '../infrastructure/logging/logger.js';
import { nowIso } from '../shared/time/datetime.js';
import { sanitizedStringList, toTrimmedString } from './ipc-shared.js';
import type { RequestOnlyCapabilityReview } from './ipc-request-only-capability-review.js';
import { maybeEnqueueApprovedDependencyBake } from './toolchain-bake-bootstrap.js';

export async function maybeEnqueueDependencyBakeOnApproval(input: {
  review: RequestOnlyCapabilityReview;
  appId: AppId;
  agentId: AgentId;
  conversationId: string;
}): Promise<string | null> {
  if (input.review.toolName !== 'request_skill_dependency_install') return null;
  const ecosystem = toTrimmedString(input.review.toolInput.ecosystem, {
    maxLen: 64,
  });
  if (ecosystem !== 'npm') return null;
  const packages = sanitizedStringList(
    Array.isArray(input.review.toolInput.packages)
      ? input.review.toolInput.packages
      : [],
  );
  if (packages.length === 0) return null;
  try {
    const result = await maybeEnqueueApprovedDependencyBake({
      appId: input.appId,
      packages,
      requestedByAgentId: input.agentId,
      approvedByConversationId: input.conversationId,
      approvedAt: nowIso(),
    });
    if (!result) return null;
    const names = packages.join(', ');
    return result.deduplicated
      ? `Approved ${input.review.displayName}. A toolchain bake for ${names} is already in progress for this fleet; it will be available on workers once activated.`
      : `Approved ${input.review.displayName}. Queued a sandboxed toolchain bake for ${names}; it will be available on workers once baked and activated.`;
  } catch (err) {
    logger.warn(
      { err, appId: input.appId },
      'Failed to enqueue approved toolchain bake',
    );
    return `Approved ${input.review.displayName}, but I could not queue the setup. I left it unavailable; try again after the setup issue is fixed.`;
  }
}
