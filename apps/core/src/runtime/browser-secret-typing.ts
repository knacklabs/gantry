import { CapabilitySecretService } from '../application/capability-secrets/capability-secret-service.js';
import {
  assertValidCapabilitySecretName,
  normalizeCapabilitySecretName,
} from '../domain/capability-secrets/capability-secrets.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type {
  CapabilitySecretRepository,
  ToolCatalogRepository,
} from '../domain/ports/repositories.js';
import { semanticCapabilityFromToolCatalogItem } from '../shared/semantic-capabilities.js';

interface BrowserSecretTypeRequest {
  payload: Record<string, unknown>;
  appId?: string;
  agentId?: string;
  runId?: string;
  jobId?: string;
  publicToolName?: string;
}

interface BrowserSecretTypeContext {
  getCapabilitySecretRepository?: () => CapabilitySecretRepository | undefined;
  getToolRepository?: () => ToolCatalogRepository | undefined;
  publishRuntimeEvent?: (event: {
    appId: never;
    agentId?: never;
    runId?: never;
    jobId?: never;
    eventType: typeof RUNTIME_EVENT_TYPES.CREDENTIAL_CAPABILITY_USED;
    actor: string;
    payload: unknown;
  }) => Promise<void> | void;
}

function requiredPayloadString(
  payload: Record<string, unknown>,
  key: string,
): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`type_secret requires payload.${key}`);
  }
  return value.trim();
}

function assertTypeSecretPayload(payload: Record<string, unknown>): void {
  const allowed = new Set(['target', 'secret_name', 'slowly', 'submit']);
  const unknown = Object.keys(payload).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `type_secret does not support payload field(s): ${unknown.sort().join(', ')}`,
    );
  }
}

async function selectedCapabilityIdsForSecretTyping(
  request: BrowserSecretTypeRequest,
  repository: ToolCatalogRepository,
): Promise<string[]> {
  if (!request.appId || !request.agentId) {
    throw new Error('type_secret requires signed app and agent context.');
  }
  const bindings = await repository.listAgentToolBindings({
    appId: request.appId as never,
    agentId: request.agentId as never,
  });
  const activeBindings = bindings.filter(
    (binding) => binding.status === 'active',
  );
  const out = new Set<string>();
  for (const binding of activeBindings) {
    const tool = await repository.getTool(binding.toolId);
    if (!tool || (tool.appId && tool.appId !== request.appId)) continue;
    const name = tool.name?.trim();
    if (name) out.add(name);
    const capability = semanticCapabilityFromToolCatalogItem({
      name,
      inputSchema: tool.inputSchema,
    });
    if (capability?.capabilityId) out.add(capability.capabilityId);
  }
  return [...out];
}

async function publishBrowserSecretUsed(input: {
  context: BrowserSecretTypeContext;
  request: BrowserSecretTypeRequest;
  secretName: string;
  capabilityIds: readonly string[];
}): Promise<void> {
  if (!input.context.publishRuntimeEvent || !input.request.appId) return;
  await input.context.publishRuntimeEvent({
    appId: input.request.appId as never,
    ...(input.request.agentId
      ? { agentId: input.request.agentId as never }
      : {}),
    ...(input.request.runId ? { runId: input.request.runId as never } : {}),
    ...(input.request.jobId ? { jobId: input.request.jobId as never } : {}),
    eventType: RUNTIME_EVENT_TYPES.CREDENTIAL_CAPABILITY_USED,
    actor: 'browser.type_secret',
    payload: {
      secretName: input.secretName,
      capabilityIds: input.capabilityIds,
      publicToolName: input.request.publicToolName ?? null,
      browserAction: 'type_secret',
    },
  });
}

export async function resolveBrowserSecretTypePayload(input: {
  request: BrowserSecretTypeRequest;
  context: BrowserSecretTypeContext;
}): Promise<Record<string, unknown>> {
  assertTypeSecretPayload(input.request.payload);
  const target = requiredPayloadString(input.request.payload, 'target');
  const secretName = normalizeCapabilitySecretName(
    requiredPayloadString(input.request.payload, 'secret_name'),
  );
  assertValidCapabilitySecretName(secretName);
  if (!input.request.appId) {
    throw new Error('type_secret requires signed app context.');
  }
  const secretRepository = input.context.getCapabilitySecretRepository?.();
  if (!secretRepository) {
    throw new Error('type_secret credential repository is unavailable.');
  }
  const toolRepository = input.context.getToolRepository?.();
  if (!toolRepository) {
    throw new Error('type_secret capability repository is unavailable.');
  }
  const selectedCapabilityIds = await selectedCapabilityIdsForSecretTyping(
    input.request,
    toolRepository,
  );
  const secret = await secretRepository.getSecret({
    appId: input.request.appId as never,
    name: secretName,
  });
  if (!secret?.value) {
    throw new Error(
      `Browser secret is not available in Credential Center: ${secretName}.`,
    );
  }
  if (secret.allowedCapabilityIds.length === 0) {
    throw new Error(
      `Browser secret typing requires ${secretName} to be scoped to at least one selected capability.`,
    );
  }
  const matchingCapabilityIds = secret.allowedCapabilityIds.filter(
    (capabilityId) => selectedCapabilityIds.includes(capabilityId),
  );
  if (matchingCapabilityIds.length === 0) {
    throw new Error(
      `Browser secret is not approved for this agent: ${secretName}.`,
    );
  }
  const resolved = await new CapabilitySecretService(
    secretRepository,
  ).resolveEnv({
    appId: input.request.appId as never,
    names: [secretName],
    allowedCapabilityIds: selectedCapabilityIds,
  });
  const text = resolved.env[secretName];
  if (!text) {
    throw new Error(
      `Browser secret is not available or not approved for this agent: ${secretName}.`,
    );
  }
  await publishBrowserSecretUsed({
    context: input.context,
    request: input.request,
    secretName,
    capabilityIds: matchingCapabilityIds,
  });
  return {
    target,
    text,
    ...(input.request.payload.slowly === true ? { slowly: true } : {}),
    ...(input.request.payload.submit === true ? { submit: true } : {}),
  };
}
