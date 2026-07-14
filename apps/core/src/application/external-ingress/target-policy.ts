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
  if (target.kind === 'conversation_message') {
    const conversationId = readOptionalString(target, 'conversationId');
    if (!conversationId || !allows(policy.conversationIds, conversationId)) {
      throw new ApplicationError(
        'FORBIDDEN',
        'Ingress is not allowed to invoke this conversation target',
      );
    }
    const agentId = readOptionalString(target, 'agentId');
    if (!agentId) {
      if (policy.allowedAgentIds.size > 0) {
        throw new ApplicationError(
          'FORBIDDEN',
          'Ingress is not allowed to invoke this conversation agent target',
        );
      }
      return;
    }
    if (allows(policy.allowedAgentIds, agentId)) return;
    throw new ApplicationError(
      'FORBIDDEN',
      'Ingress is not allowed to invoke this conversation agent target',
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

export function validateIngressMetadata(metadata: unknown): unknown {
  const root =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : metadata === undefined
        ? {}
        : null;
  if (!root) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'external ingress metadata must be an object',
    );
  }
  const keys = Object.keys(root);
  if (keys.length > 20) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'external ingress metadata has too many keys',
    );
  }
  validateTargetPolicy(root.targetPolicy);
  validateTemplates(root.templates);
  return root;
}

export function renderTemplate(
  prompt: string,
  variables: Record<string, string>,
): string {
  return prompt.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key) => {
    return variables[String(key)] ?? '';
  });
}

function validateTargetPolicy(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'external ingress targetPolicy must be an object',
    );
  }
  const policy = value as Record<string, unknown>;
  const supported = new Set([
    'allowedTargetKinds',
    'sessionIds',
    'conversationIds',
    'allowedAgentIds',
    'jobIds',
    'templateIds',
  ]);
  for (const key of Object.keys(policy)) {
    if (!supported.has(key)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `external ingress targetPolicy.${key} is not supported`,
      );
    }
  }
  validatePolicySet(policy.allowedTargetKinds, 'allowedTargetKinds', [
    'session_message',
    'conversation_message',
    'job_trigger',
    'job_template',
  ]);
  validatePolicySet(policy.sessionIds, 'sessionIds');
  validatePolicySet(policy.conversationIds, 'conversationIds');
  validatePolicySet(policy.allowedAgentIds, 'allowedAgentIds');
  validatePolicySet(policy.jobIds, 'jobIds');
  validatePolicySet(policy.templateIds, 'templateIds');
}

function validatePolicySet(
  value: unknown,
  field: string,
  allowedValues?: string[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 100) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      `external ingress targetPolicy.${field} must be an array with at most 100 entries`,
    );
  }
  const allowed = allowedValues ? new Set(allowedValues) : null;
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > 300) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `external ingress targetPolicy.${field} contains an invalid entry`,
      );
    }
    if (allowed && !allowed.has(item)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `external ingress targetPolicy.${field} contains unsupported target kind: ${item}`,
      );
    }
  }
}

function validateTemplates(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'external ingress templates must be an object',
    );
  }
  const templates = value as Record<string, unknown>;
  const entries = Object.entries(templates);
  if (entries.length > 50) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'external ingress templates has too many entries',
    );
  }
  for (const [templateId, raw] of entries) {
    if (!templateId.trim() || templateId.length > 120) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'external ingress template id is invalid',
      );
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `external ingress template ${templateId} must be an object`,
      );
    }
    const template = raw as Record<string, unknown>;
    const supported = new Set([
      'name',
      'prompt',
      'sessionId',
      'allowedVariables',
    ]);
    for (const key of Object.keys(template)) {
      if (!supported.has(key)) {
        throw new ApplicationError(
          'INVALID_REQUEST',
          `external ingress template ${templateId}.${key} is not supported`,
        );
      }
    }
    for (const field of ['name', 'prompt', 'sessionId']) {
      if (
        typeof template[field] !== 'string' ||
        !template[field].trim() ||
        template[field].length > (field === 'prompt' ? 20_000 : 300)
      ) {
        throw new ApplicationError(
          'INVALID_REQUEST',
          `external ingress template ${templateId}.${field} is invalid`,
        );
      }
    }
    validateTemplateVariables(template.allowedVariables, templateId);
  }
}

function validateTemplateVariables(value: unknown, templateId: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 100) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      `external ingress template ${templateId}.allowedVariables must be an array with at most 100 entries`,
    );
  }
  for (const variable of value) {
    if (
      typeof variable !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,80}$/.test(variable)
    ) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `external ingress template ${templateId}.allowedVariables contains an invalid entry`,
      );
    }
  }
}

function readTargetPolicy(metadata: unknown): {
  targetKinds: Set<string>;
  sessionIds: Set<string>;
  conversationIds: Set<string>;
  allowedAgentIds: Set<string>;
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
    allowedAgentIds: readPolicySet(policy.allowedAgentIds),
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
