import { createHash } from 'node:crypto';
/** Canonical output identity is isolated by application, goal, and attempt. */
export function sourceAnswerOutputId(
  appId: string,
  answerGoalId: string,
  attemptId: string,
): string {
  return `source-output:${createHash('sha256')
    .update(JSON.stringify([appId, answerGoalId, attemptId]))
    .digest('hex')}`;
}
