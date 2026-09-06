import { randomUUID } from 'node:crypto';

export function newHumanDecisionId(): string {
  return randomUUID();
}

export function isHumanDecisionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
