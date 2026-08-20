import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
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

// A managed Chrome profile is already resident in the same task when this
// command starts. Node's normal virtual-memory reservation cannot initialize
// under a shell virtual-memory ulimit, even when actual memory remains small.
// The ECS task retains the hard memory boundary; keep the generic CPU and
// process limits while omitting only the incompatible virtual-address cap.
const MANAGED_BROWSER_ACTION_RESOURCE_LIMITS = {
  ...DEFAULT_ASYNC_RESOURCE_LIMITS,
  memoryMb: 0,
};

// Reviewed deterministic browser actions can legitimately process large,
// paginated sources. Keep the lane bounded, while allowing the owning job's
// configured timeout to cover work that cannot finish inside a normal agent
// turn. Terminal job cleanup still closes Chrome immediately on completion.
const MANAGED_BROWSER_ACTION_TIMEOUT_MS = 2 * 60 * 60_000;
const MANAGED_BROWSER_CLEANUP_GRACE_MS = 60_000;

// This name is only meaningful to the run-scoped egress gateway. It is mapped
// to the exact loopback CDP port for the managed browser; it has no DNS record
// and cannot be reached from outside the sandboxed execution flow.
const MANAGED_BROWSER_CDP_GATEWAY_HOST = 'browser-cdp.gantry.internal';

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
  const browser = await input.deps.openBrowserSession(profileName, {
    // Direct CDP traffic does not pass through Gantry's Browser tool, so it
    // cannot refresh the generic five-minute idle timer. Keep Chrome alive for
    // the bounded deterministic action; terminal job cleanup still closes it.
    keepAliveMs: deterministicBrowserKeepAliveMs(input.timeoutMs),
  });
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
    privateNetworkHostMappings: [
      {
        authority: `${MANAGED_BROWSER_CDP_GATEWAY_HOST}:${browser.port}`,
        connectHost: '127.0.0.1',
      },
    ],
  });
  try {
    const env = {
      ...buildAsyncCommandEnv(),
      ...buildToolNetworkEnv({ proxyUrl: gateway.proxyUrl }),
      ...skillEnv.env,
      GANTRY_BROWSER_PROFILE_NAME: profileName,
      GANTRY_BROWSER_MANAGED_AUTOMATION: '1',
    };
    const summaries: string[] = [];
    for (const action of input.actions) {
      const bridgePort = managedBrowserSandboxBridgePort({
        runId: input.runId,
        capabilityId: action.capabilityId,
      });
      const outcome = await runSandboxedAsyncCommand(
        input.deps.runnerSandboxProvider,
        {
          command: managedBrowserSandboxBridgeCommand({
            command: action.command,
            bridgePort,
            browserPort: browser.port,
          }),
          cwd: workspacePath,
          env,
          timeoutMs: Math.min(
            input.timeoutMs,
            MANAGED_BROWSER_ACTION_TIMEOUT_MS,
          ),
          outputMaxBytes: 4_000,
          protectedReadPaths: [],
          protectedWritePaths: [],
          allowedNetworkHosts,
          egressProxyUrl: gateway.proxyUrl,
          resourceLimits: MANAGED_BROWSER_ACTION_RESOURCE_LIMITS,
          allowLocalBinding: true,
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

export function deterministicBrowserKeepAliveMs(timeoutMs: number): number {
  const boundedActionMs = Math.max(
    10_000,
    Math.min(timeoutMs, MANAGED_BROWSER_ACTION_TIMEOUT_MS),
  );
  return boundedActionMs + MANAGED_BROWSER_CLEANUP_GRACE_MS;
}

function managedBrowserSandboxBridgePort(input: {
  runId: string;
  capabilityId: string;
}): number {
  const offset = createHash('sha256')
    .update(`${input.runId}:${input.capabilityId}`)
    .digest()
    .readUInt16BE(0);
  return 20_000 + (offset % 20_000);
}

function managedBrowserSandboxBridgeCommand(input: {
  command: string;
  bridgePort: number;
  browserPort: number;
}): string {
  // Sandbox Runtime creates its own network namespace. Its localhost:3128
  // proxy is the only approved route back to the parent task's run-scoped
  // egress gateway, which maps this synthetic authority to the exact CDP port.
  const target = `PROXY:localhost:${MANAGED_BROWSER_CDP_GATEWAY_HOST}:${input.browserPort},proxyport=3128`;
  return [
    'set -eu',
    // Sandbox Runtime mounts /tmp read-only. Playwright creates temporary
    // artifacts while attaching over CDP, so keep them in the writable skill
    // workspace rather than inheriting the runtime's unavailable /tmp/claude.
    'gantry_playwright_tmp="$PWD/.gantry-playwright-tmp"',
    'mkdir -p "$gantry_playwright_tmp"',
    'export TMPDIR="$gantry_playwright_tmp"',
    // The sandbox makes /tmp read-only. Keep the bridge diagnostics beside the
    // Playwright artifacts in the writable run workspace.
    `gantry_browser_bridge_log="$gantry_playwright_tmp/gantry-browser-cdp-${input.bridgePort}.log"`,
    `socat -d -d "TCP-LISTEN:${input.bridgePort},bind=127.0.0.1,reuseaddr,fork" "${target}" 2>"$gantry_browser_bridge_log" &`,
    'gantry_browser_bridge_pid=$!',
    'cleanup_gantry_browser_bridge() {',
    '  kill "$gantry_browser_bridge_pid" 2>/dev/null || true',
    '  wait "$gantry_browser_bridge_pid" 2>/dev/null || true',
    '  rm -f "$gantry_browser_bridge_log"',
    '}',
    'trap cleanup_gantry_browser_bridge EXIT INT TERM',
    'if ! kill -0 "$gantry_browser_bridge_pid" 2>/dev/null; then',
    '  echo "Managed browser CDP bridge failed to start." >&2',
    '  tail -n 20 "$gantry_browser_bridge_log" >&2 || true',
    '  exit 70',
    'fi',
    'gantry_browser_bridge_ready=0',
    'for gantry_browser_bridge_attempt in 1 2 3 4 5; do',
    `  if wget -q -T 2 -O /dev/null "http://127.0.0.1:${input.bridgePort}/json/version"; then`,
    '    gantry_browser_bridge_ready=1',
    '    break',
    '  fi',
    '  sleep 0.2',
    'done',
    'if [ "$gantry_browser_bridge_ready" -ne 1 ]; then',
    '  echo "Managed browser CDP bridge could not reach Chrome." >&2',
    '  tail -n 20 "$gantry_browser_bridge_log" >&2 || true',
    '  exit 70',
    'fi',
    `export GANTRY_BROWSER_CDP_ENDPOINT=http://127.0.0.1:${input.bridgePort}`,
    'set +e',
    '(',
    input.command,
    ')',
    'gantry_browser_command_status=$?',
    'set -e',
    'if [ "$gantry_browser_command_status" -ne 0 ]; then',
    '  echo "Managed browser CDP bridge diagnostic:" >&2',
    '  tail -n 20 "$gantry_browser_bridge_log" >&2 || true',
    'fi',
    'exit "$gantry_browser_command_status"',
  ].join('\n');
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

const resolveThisModule = createRequire(import.meta.url);

export function resolveDeterministicSkillNodeModulesDir(): string | null {
  const configuredDirectory = process.env.GANTRY_SKILL_NODE_MODULES_DIR?.trim();
  if (configuredDirectory && fs.existsSync(configuredDirectory)) {
    return configuredDirectory;
  }

  const workingDirectoryModules = path.join(process.cwd(), 'node_modules');
  if (fs.existsSync(workingDirectoryModules)) return workingDirectoryModules;

  // Jobs run from an agent workspace (for example /srv/reagent/home), not
  // necessarily the application directory. Resolve a package that Gantry owns
  // to find the installed runtime dependency tree without tying this to any
  // particular skill or application.
  try {
    const sandboxRuntimePackage = resolveThisModule.resolve(
      '@anthropic-ai/sandbox-runtime/package.json',
    );
    const runtimeModules = path.dirname(
      path.dirname(path.dirname(sandboxRuntimePackage)),
    );
    return fs.existsSync(runtimeModules) ? runtimeModules : null;
  } catch {
    return null;
  }
}

function linkDeterministicSkillNodeModules(skillDirectory: string): void {
  if (!fs.existsSync(path.join(skillDirectory, 'package.json'))) return;
  const runtimeNodeModules = resolveDeterministicSkillNodeModulesDir();
  if (!runtimeNodeModules) return;
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
