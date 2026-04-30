import { ApplicationError } from '../common/application-error.js';

export type IngressTarget = Record<string, unknown> & { kind: string };

export function assertTargetAllowed(
  metadata: unknown,
  target: IngressTarget,
): void {
  const policy = readTargetPolicy(metadata);
  if (!allows(policy.targetKinds, target.kind)) {
    throw new ApplicationError(
      'FORBIDDEN',
      `Ingress is not allowed to invoke target kind: ${target.kind}`,
    );
  }
  if (target.kind === 'session_message') {
    const sessionId = readOptionalString(target, 'sessionId');
    if (sessionId) {
      if (allows(policy.sessionIds, sessionId)) return;
      throw new ApplicationError(
        'FORBIDDEN',
        'Ingress is not allowed to invoke this session target',
      );
    }
    const conversationId = readOptionalString(target, 'conversationId');
    if (conversationId && allows(policy.conversationIds, conversationId)) {
      return;
    }
    throw new ApplicationError(
      'FORBIDDEN',
      'Ingress is not allowed to invoke this session target',
    );
  }
  if (target.kind === 'job_trigger') {
    const jobId = readOptionalString(target, 'jobId');
    if (jobId && allows(policy.jobIds, jobId)) return;
    throw new ApplicationError(
      'FORBIDDEN',
      'Ingress is not allowed to trigger this job',
    );
  }
  if (target.kind === 'job_template') {
    const templateId = readOptionalString(target, 'templateId');
    if (templateId && allows(policy.templateIds, templateId)) return;
    throw new ApplicationError(
      'FORBIDDEN',
      'Ingress is not allowed to invoke this job template',
    );
  }
}

export function readString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApplicationError('INVALID_REQUEST', `${key} is required`);
  }
  return value.trim();
}

export function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readVariables(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const variables: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' || typeof raw === 'number') {
      variables[key] = String(raw);
    }
  }
  return variables;
}

export function readTemplate(
  metadata: unknown,
  templateId: string,
): {
  name: string;
  prompt: string;
  sessionId: string;
  allowedVariables?: string[];
} {
  const root =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const templates =
    root.templates && typeof root.templates === 'object'
      ? (root.templates as Record<string, unknown>)
      : {};
  const template = templates[templateId];
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw new ApplicationError('NOT_FOUND', 'Job template not found');
  }
  const record = template as Record<string, unknown>;
  const allowed = Array.isArray(record.allowedVariables)
    ? record.allowedVariables.filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  return {
    name: readString(record, 'name'),
    prompt: readString(record, 'prompt'),
    sessionId: readString(record, 'sessionId'),
    allowedVariables: allowed,
  };
}

export function renderTemplate(
  prompt: string,
  variables: Record<string, string>,
): string {
  return prompt.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key) => {
    return variables[String(key)] ?? '';
  });
}

function readTargetPolicy(metadata: unknown): {
  targetKinds: Set<string>;
  sessionIds: Set<string>;
  conversationIds: Set<string>;
  jobIds: Set<string>;
  templateIds: Set<string>;
} {
  const root =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const policy =
    root.targetPolicy &&
    typeof root.targetPolicy === 'object' &&
    !Array.isArray(root.targetPolicy)
      ? (root.targetPolicy as Record<string, unknown>)
      : {};
  return {
    targetKinds: readPolicySet(policy.allowedTargetKinds),
    sessionIds: readPolicySet(policy.sessionIds),
    conversationIds: readPolicySet(policy.conversationIds),
    jobIds: readPolicySet(policy.jobIds),
    templateIds: readPolicySet(policy.templateIds),
  };
}

function readPolicySet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function allows(allowed: Set<string>, value: string): boolean {
  return allowed.has('*') || allowed.has(value);
}
