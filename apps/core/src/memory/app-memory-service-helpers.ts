import { hashText } from './app-memory-canonical-codec.js';

export function memoryContentHash(input: {
  appId: string;
  agentId: string;
  subjectType: string;
  subjectId: string;
  key: string;
  value: string;
}): string {
  return hashText(
    `${input.appId}:${input.agentId}:${input.subjectType}:${input.subjectId}:${input.key}:${input.value}`,
  );
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}
