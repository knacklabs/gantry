import type { ListJobsInput } from './job-model-types.js';

export function jobListQuery(input?: ListJobsInput): string {
  if (!input) return '';
  const params = new URLSearchParams();
  if (input.agentId) params.set('agentId', input.agentId);
  if (input.workspaceKey) params.set('workspaceKey', input.workspaceKey);
  if (input.conversationJid)
    params.set('conversationJid', input.conversationJid);
  if (input.kind) params.set('kind', input.kind);
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  const statuses = Array.isArray(input.status)
    ? input.status
    : input.status
      ? [input.status]
      : [];
  for (const status of statuses) params.append('status', status);
  return params.toString() ? `?${params}` : '';
}
