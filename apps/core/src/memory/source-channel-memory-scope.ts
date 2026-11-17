import { createHash } from 'node:crypto';
import { normalizeSubject } from './app-memory-boundaries.js';
/** Native person keys are isolated even when two host apps use the same ID. */
export function sourceChannelNativePersonId(
  appId: string,
  personId: string,
): string {
  return `source_person_${createHash('sha256')
    .update(JSON.stringify([appId, personId]))
    .digest('hex')
    .slice(0, 32)}`;
}
/** Trusted workspace binding is distinct from the runtime filesystem folder. */
export function sourceChannelMemorySubject(input: {
  appId: string;
  agentId: string;
  workspaceId: string;
  personId?: string;
  scope?: 'group' | 'user';
}) {
  const workspace = `workspace_${createHash('sha256').update(input.workspaceId).digest('hex').slice(0, 32)}`;
  if (input.scope === 'user') {
    if (!input.personId)
      throw new Error(
        'Personal workspace learning requires requester identity',
      );
    return normalizeSubject({
      appId: input.appId,
      agentId: input.agentId,
      userId: sourceChannelNativePersonId(input.appId, input.personId),
      subjectType: 'user',
      subjectId: `preference_${createHash('sha256')
        .update(JSON.stringify([input.workspaceId, input.personId]))
        .digest('hex')
        .slice(0, 32)}`,
    });
  }
  return normalizeSubject({
    appId: input.appId,
    agentId: input.agentId,
    groupId: workspace,
    subjectType: 'group',
  });
}
export function assertSourceLearningContent(input: {
  kind?: string;
  key: string;
  value: string;
  why?: string;
}) {
  if (!['preference', 'correction', 'constraint'].includes(input.kind ?? ''))
    throw new Error(
      'Workspace learning accepts general preferences and process corrections only',
    );
}
