import { getRuntimeSettingsForConfig } from '../config/index.js';
import { resolveSelectedSkillEnvForAgent } from '../application/capability-secrets/skill-secret-projection.js';
import { splitAccessRequirements } from '../application/jobs/job-access-requirements.js';
import { skillActionSource } from '../domain/skills/skill-action-permissions.js';
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
  const secrets = input.deps.getCapabilitySecretRepository?.();
  if (!skills || !secrets)
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
          cwd: resolveWorkspaceFolderPath(input.groupFolder),
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
