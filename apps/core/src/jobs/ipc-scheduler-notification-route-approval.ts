import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import type { JobManagementServiceDeps } from '../application/jobs/job-management-types.js';
import type { TaskContext } from './ipc-types.js';

// Same-channel human approval for a scheduler job's notification_routes
// entries that point outside the conversation making the request (a
// different conversation, or the same conversation via a different provider
// account). Reuses the exact requestPermissionApproval surface every other
// same-channel approval flow in this codebase already goes through (see
// registerAgentHandler / requestMcpServerHandler in ipc-admin-handlers.ts).
export function createApproveJobNotificationRoutes(
  context: TaskContext,
): JobManagementServiceDeps['approveJobNotificationRoutes'] {
  return async (request) => {
    const { deps, data, sourceAgentFolder } = context;
    if (typeof deps.requestPermissionApproval !== 'function') {
      return {
        approved: false,
        reason: 'No approval surface configured for this agent.',
      };
    }
    const routeLabels = request.routesBeyondContext
      .map((route) => `${route.label} (${route.conversationJid})`)
      .join(', ');
    const approvalResult = await deps.requestPermissionApproval({
      requestId: `job-notification-route-${globalThis.crypto.randomUUID()}`,
      appId: data.appId,
      agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder),
      sourceAgentFolder,
      targetJid: request.authenticatedContext.conversationJid,
      threadId: request.authenticatedContext.threadId ?? data.authThreadId,
      decisionPolicy: 'same_channel',
      decisionOptions: ['allow_once', 'cancel'],
      toolName: 'scheduler_upsert_job',
      displayName: `Notify other conversations: ${routeLabels}`,
      title: 'Approve cross-conversation job notifications',
      description: `Job "${request.jobName}" wants to post its completion notice outside this conversation, to: ${routeLabels}. Approving lets it post there automatically on every future run of this job.`,
      decisionReason: `${request.operation === 'create' ? 'New job' : 'Job update'}: ${request.jobName}`,
      toolInput: { routesBeyondContext: request.routesBeyondContext },
    });
    if (approvalResult.kind === 'delivery_failure') {
      return {
        approved: false,
        reason: `Could not deliver approval prompt: ${approvalResult.userMessage}`,
      };
    }
    const { decision } = approvalResult;
    return {
      approved: decision.approved,
      reason: decision.reason,
      approvedConversationJid: request.authenticatedContext.conversationJid,
    };
  };
}
