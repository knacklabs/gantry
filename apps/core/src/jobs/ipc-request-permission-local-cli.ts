import type { JobCapabilityRequirement } from '../domain/types.js';
import type { IpcDeps } from '../runtime/ipc-domain-types.js';
import {
  formatCapabilityRequirement,
  localCliCommandTemplatePermissionRule,
} from '../application/jobs/job-capability-requirements.js';
import { parseSemanticCapabilityRule } from '../shared/semantic-capability-ids.js';
import { toTrimmedString } from './ipc-shared.js';

export interface RequestPermissionLocalCliReview {
  toolName: string;
  toolInput: Record<string, unknown>;
}

export async function jobLocalCliCapabilityConflict(input: {
  deps: Pick<IpcDeps, 'opsRepository'>;
  jobId?: string;
  review: RequestPermissionLocalCliReview;
}): Promise<string | null> {
  if (input.review.toolName !== 'request_permission') return null;
  const capabilityIds = requestedSemanticCapabilityIds(input.review.toolInput);
  if (capabilityIds.length === 0 || !input.jobId) return null;
  const job = await input.deps.opsRepository.getJobById?.(input.jobId);
  const localCliRequirement = jobCapabilityRequirements(job).find(
    (requirement) =>
      capabilityIds.includes(requirement.capabilityId) &&
      requirement.implementation?.kind === 'local_cli',
  );
  if (!localCliRequirement) return null;
  if (
    requestMatchesLocalCliRequirement(
      input.review.toolInput,
      localCliRequirement,
    )
  ) {
    return null;
  }
  const rule = localCliCommandTemplatePermissionRule(
    localCliRequirement.implementation?.commandTemplate,
    localCliRequirement.implementation?.executablePath,
  );
  const capabilityId = localCliRequirement.capabilityId;
  return [
    `This job declares ${formatCapabilityRequirement(localCliRequirement)}.`,
    rule
      ? `Request the scoped command permission Bash(${rule}) instead of the generic capability ${semanticCapabilityName(capabilityId)}.`
      : `Request the declared local CLI implementation instead of the generic capability ${semanticCapabilityName(capabilityId)}.`,
  ].join(' ');
}

function requestedSemanticCapabilityIds(
  toolInput: Record<string, unknown>,
): string[] {
  const ids = new Set<string>();
  const explicit = toTrimmedString(toolInput.capabilityId, { maxLen: 160 });
  if (explicit) ids.add(explicit);
  for (const toolName of sanitizedStringList([
    toolInput.toolName,
    ...(Array.isArray(toolInput.toolNames) ? toolInput.toolNames : []),
  ])) {
    const parsed = parseSemanticCapabilityRule(toolName);
    if (parsed) ids.add(parsed);
  }
  return [...ids];
}

function requestMatchesLocalCliRequirement(
  toolInput: Record<string, unknown>,
  requirement: JobCapabilityRequirement,
): boolean {
  const rule = localCliCommandTemplatePermissionRule(
    requirement.implementation?.commandTemplate,
    requirement.implementation?.executablePath,
  );
  if (!rule) return false;
  const toolNames = sanitizedStringList([
    toolInput.toolName,
    ...(Array.isArray(toolInput.toolNames) ? toolInput.toolNames : []),
  ]);
  const requestedRule = toTrimmedString(toolInput.rule, { maxLen: 2048 });
  return toolNames.includes('Bash') && requestedRule === rule;
}

function jobCapabilityRequirements(job: unknown): JobCapabilityRequirement[] {
  if (!job || typeof job !== 'object') return [];
  const raw = (job as { capability_requirements?: unknown })
    .capability_requirements;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const capabilityId = toTrimmedString(
      (entry as { capabilityId?: unknown; capability_id?: unknown })
        .capabilityId ??
        (entry as { capabilityId?: unknown; capability_id?: unknown })
          .capability_id,
      { maxLen: 160 },
    );
    if (!capabilityId) return [];
    const implementation =
      typeof (entry as { implementation?: unknown }).implementation ===
        'object' &&
      (entry as { implementation?: unknown }).implementation !== null
        ? (entry as { implementation: Record<string, unknown> }).implementation
        : undefined;
    const kind = toTrimmedString(implementation?.kind, { maxLen: 80 });
    const normalizedKind =
      kind === 'local_cli' ||
      kind === 'configured_access' ||
      kind === 'mcp_server' ||
      kind === 'builtin_tool'
        ? kind
        : undefined;
    return [
      {
        capabilityId,
        reason:
          toTrimmedString((entry as { reason?: unknown }).reason, {
            maxLen: 2000,
          }) || 'Required by this job.',
        ...(normalizedKind
          ? {
              implementation: {
                kind: normalizedKind,
                name: toTrimmedString(implementation?.name, { maxLen: 120 }),
                executablePath: toTrimmedString(
                  implementation?.executablePath ??
                    implementation?.executable_path,
                  { maxLen: 2048 },
                ),
                commandTemplate: toTrimmedString(
                  implementation?.commandTemplate ??
                    implementation?.command_template,
                  { maxLen: 2048 },
                ),
              },
            }
          : {}),
      },
    ];
  });
}

function semanticCapabilityName(capabilityId: string): string {
  return `capability:${capabilityId}`;
}

function sanitizedStringList(values: unknown[]): string[] {
  return [
    ...new Set(
      values
        .slice(0, 50)
        .map((item) => toTrimmedString(item, { maxLen: 512 }))
        .filter((item): item is string => Boolean(item)),
    ),
  ];
}
