import { createHash } from 'node:crypto';
import { normalizeSubject } from './app-memory-boundaries.js';
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
      userId: input.personId,
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
  // Reject concrete tender identifiers, dates, monetary/quantity conditions and
  // document-source assertions before the normal secret and evidence guards.
  if (
    /\b(?:tender|bid|rfp|clause|deadline|eligibilit|document says|document states|emd|rs\.?|inr|usd|crore|lakh)\b|\d{2,4}[/-]\d{1,2}[/-]\d{1,4}|\b\d+(?:\.\d+)?\s*(?:%|million|years?|days?)\b/iu.test(
      [input.key, input.value, input.why ?? ''].join(' '),
    )
  )
    throw new Error(
      'Tender facts cannot be promoted to reusable workspace learning',
    );
}
