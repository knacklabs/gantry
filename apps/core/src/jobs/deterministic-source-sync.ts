import fs from 'node:fs';
import path from 'node:path';

import { getRuntimeSettingsForConfig } from '../config/index.js';
import { resolveSelectedSkillEnvForAgent } from '../application/capability-secrets/skill-secret-projection.js';
import { resolveSelectedSkillProjection } from '../application/skills/selected-skill-projection.js';
import { splitAccessRequirements } from '../application/jobs/job-access-requirements.js';
import { materializedSkillDirectoryNameFor } from '../domain/skills/skills.js';
import type { SkillArtifactStore } from '../domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '../domain/ports/repositories.js';
import { skillActionSource } from '../domain/skills/skill-action-permissions.js';
import {
  normalizeSkillAssetPath,
  writeSkillAssets,
} from '../shared/skill-artifact-helpers.js';
import type { Job } from '../domain/types.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
import { resolveWorkspaceFolderPath } from '../platform/workspace-folder.js';
import { resolveConversationBrowserProfile } from '../shared/browser-profile-scope.js';
import { buildToolNetworkEnv } from '../shared/tool-network-env.js';
import {
  ensureEgressGateway,
  closeEgressGateway,
} from '../runtime/egress-gateway.js';
import {
  buildAsyncCommandEnv,
  DEFAULT_ASYNC_RESOURCE_LIMITS,
  runSandboxedAsyncCommand,
} from './async-command-sandbox-runner.js';
import type { SchedulerDependencies } from './types.js';

/** A reviewed skill can opt into this generic, model-free execution lane. */
type DeterministicManagedBrowserAction = {
  capabilityId: string;
  command: string;
  networkHosts: string[];
  skillId: string;
  skillName: string;
};

export function resolveDeterministicManagedBrowserActions(
  job: Job,
  capabilities: readonly SemanticCapabilityDefinition[],
): DeterministicManagedBrowserAction[] | null {
  const required = splitAccessRequirements(
    job.access_requirements,
  ).capabilityRequirements.map((requirement) => requirement.capabilityId);
  if (required.length === 0) return null;

  const actions: DeterministicManagedBrowserAction[] = [];
  for (const capabilityId of required) {
    const capability = capabilities.find(
      (candidate) => candidate.capabilityId === capabilityId,
    );
    const source = capability && skillActionSource(capability);
    if (
      !capability ||
      source?.browserAccess !== 'managed_browser' ||
      source.executionMode !== 'deterministic'
    ) {
      return null;
    }
    const command = capability.implementationBindings
      .map((binding) =>
        binding.kind === 'tool_rule' && typeof binding.rule === 'string'
          ? (/^RunCommand\((.+)\)$/.exec(binding.rule)?.[1] ?? '')
          : '',
      )
      .find(Boolean);
    // Command rules were parsed and pinned when the skill was reviewed.
    if (!command || !command.startsWith('skills/')) return null;
    actions.push({
      capabilityId,
      command,
      networkHosts: capability.networkHosts ?? [],
      skillId: source.skillId,
      skillName: source.skillName,
    });
  }
  return actions;
}

export async function runDeterministicManagedBrowserActions(input: {
  job: Job;
  actions: DeterministicManagedBrowserAction[];
  deps: SchedulerDependencies;
  appId: string;
  agentId: string;
  groupFolder: string;
  conversationId: string;
  providerAccountId?: string;
  accessSnapshot: Parameters<
    typeof resolveSelectedSkillEnvForAgent
  >[0]['accessSnapshot'];
  runtimeAccess: Parameters<
    typeof resolveSelectedSkillEnvForAgent
  >[0]['runtimeAccess'];
  signal: AbortSignal;
  timeoutMs: number;
  runId: string;
}): Promise<string> {
  const skills = input.deps.getSkillRepository?.();
  const skillArtifacts = input.deps.getSkillArtifactStore?.();
  const secrets = input.deps.getCapabilitySecretRepository?.();
  if (!skills || !skillArtifacts || !secrets)
    throw new Error('Managed skill repositories are unavailable.');
  if (!input.deps.openBrowserSession || !input.deps.runnerSandboxProvider) {
    throw new Error(
      'Managed browser skill execution is unavailable on this scheduler.',
    );
  }
  const profileName = resolveConversationBrowserProfile({
    agentId: input.groupFolder,
    workspaceKey: input.groupFolder,
    conversationId: input.conversationId,
    providerAccountId: input.providerAccountId ?? null,
  });
  const browser = await input.deps.openBrowserSession(profileName);
  if (!browser.running || !browser.cdpReady || !browser.port) {
    throw new Error(
      'Managed browser did not become ready for deterministic skill execution.',
    );
  }
  const skillEnv = await resolveSelectedSkillEnvForAgent({
    appId: input.appId as never,
    agentId: input.agentId as never,
    skills,
    secrets,
    runtimeAccess: input.runtimeAccess,
    accessSnapshot: input.accessSnapshot,
  });
  const workspacePath = resolveWorkspaceFolderPath(input.groupFolder);
  await materializeDeterministicSkillActions({
    actions: input.actions,
    workspacePath,
    skills,
    skillArtifacts,
    appId: input.appId,
    agentId: input.agentId,
    accessSnapshot: input.accessSnapshot,
  });
  const allowedNetworkHosts = [
    ...new Set(input.actions.flatMap((action) => action.networkHosts)),
  ].sort();
  const gateway = await ensureEgressGateway({
    key: `job-managed-skill:${input.appId}:${input.agentId}:${input.runId}`,
    settings: getRuntimeSettingsForConfig().permissions.egress,
    principal: {
      appId: input.appId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      runId: input.runId,
      jobId: input.job.id,
    },
  });
  try {
    const env = {
      ...buildAsyncCommandEnv(),
      ...buildToolNetworkEnv({ proxyUrl: gateway.proxyUrl }),
      ...skillEnv.env,
      GANTRY_BROWSER_CDP_ENDPOINT: `http://127.0.0.1:${browser.port}`,
      GANTRY_BROWSER_PROFILE_NAME: profileName,
      GANTRY_BROWSER_MANAGED_AUTOMATION: '1',
    };
    const summaries: string[] = [];
    for (const action of input.actions) {
      const outcome = await runSandboxedAsyncCommand(
        input.deps.runnerSandboxProvider,
        {
          command: action.command,
          cwd: workspacePath,
          env,
          timeoutMs: Math.min(input.timeoutMs, 240_000),
          outputMaxBytes: 4_000,
          protectedReadPaths: [],
          protectedWritePaths: [],
          allowedNetworkHosts,
          egressProxyUrl: gateway.proxyUrl,
          resourceLimits: DEFAULT_ASYNC_RESOURCE_LIMITS,
          signal: input.signal,
          appId: input.appId,
          agentId: input.agentId,
          conversationId: input.conversationId,
          parentRunId: input.runId,
          parentJobId: input.job.id,
        },
      );
      summaries.push(
        `${action.capabilityId}: ${outcome.outputSummary || 'completed'}`,
      );
    }
    return summaries.join('\n');
  } finally {
    await closeEgressGateway(gateway);
  }
}

/**
 * Agent adapters project selected skills before an LLM can run a reviewed
 * command. Deterministic actions use no adapter, so they make the same trusted
 * projection explicitly in their workspace before invoking the command.
 */
async function materializeDeterministicSkillActions(input: {
  actions: readonly DeterministicManagedBrowserAction[];
  workspacePath: string;
  skills: SkillCatalogRepository;
  skillArtifacts: SkillArtifactStore;
  appId: string;
  agentId: string;
  accessSnapshot: Parameters<
    typeof resolveSelectedSkillProjection
  >[0]['accessSnapshot'];
}): Promise<void> {
  const selectedSkillIds = [
    ...new Set(input.actions.map((action) => action.skillId)),
  ];
  const projection = await resolveSelectedSkillProjection({
    selectedSkillIds,
    skillRepository: input.skills,
    skillArtifactStore: input.skillArtifacts,
    skillContext: { appId: input.appId, agentId: input.agentId },
    accessSnapshot: input.accessSnapshot,
  });
  const projectedById = new Map(
    (projection?.skills ?? []).map((skill) => [skill.id, skill]),
  );

  for (const action of input.actions) {
    const skill = projectedById.get(action.skillId);
    if (!skill) {
      throw new Error(
        `Selected deterministic skill ${action.skillId} could not be materialized.`,
      );
    }
    const materializedName = materializedSkillDirectoryNameFor(skill.name);
    if (
      materializedName !== materializedSkillDirectoryNameFor(action.skillName)
    ) {
      throw new Error(
        `Selected deterministic skill ${action.skillId} has an unexpected materialized name.`,
      );
    }
    const skillDirectory = path.join(
      input.workspacePath,
      'skills',
      materializedName,
    );
    writeSkillAssets(skill.assets, skillDirectory);
    linkDeterministicSkillNodeModules(skillDirectory);
    makeDeterministicEntrypointExecutable({
      command: action.command,
      workspacePath: input.workspacePath,
      materializedName,
    });
  }
}

function linkDeterministicSkillNodeModules(skillDirectory: string): void {
  if (!fs.existsSync(path.join(skillDirectory, 'package.json'))) return;
  const runtimeNodeModules =
    process.env.GANTRY_SKILL_NODE_MODULES_DIR?.trim() ||
    path.join(process.cwd(), 'node_modules');
  if (!fs.existsSync(runtimeNodeModules)) return;
  const target = path.join(skillDirectory, 'node_modules');
  if (
    fs.existsSync(target) ||
    fs.lstatSync(target, { throwIfNoEntry: false })
  ) {
    return;
  }
  fs.symlinkSync(runtimeNodeModules, target, 'dir');
}

function makeDeterministicEntrypointExecutable(input: {
  command: string;
  workspacePath: string;
  materializedName: string;
}): void {
  const commandPath = input.command.trim().split(/\s+/, 1)[0];
  const prefix = `skills/${input.materializedName}/`;
  if (!commandPath?.startsWith(prefix)) return;
  const relativePath = normalizeSkillAssetPath(
    commandPath.slice(prefix.length),
  );
  const root = path.resolve(
    input.workspacePath,
    'skills',
    input.materializedName,
  );
  const entrypoint = path.resolve(root, relativePath);
  if (!entrypoint.startsWith(`${root}${path.sep}`)) return;
  const stat = fs.statSync(entrypoint, { throwIfNoEntry: false });
  if (stat?.isFile()) fs.chmodSync(entrypoint, 0o700);
}
