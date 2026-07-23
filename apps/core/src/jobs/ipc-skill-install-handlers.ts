import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillService } from '../application/skills/skill-service.js';
import type { AgentId } from '../domain/agent/agent.js';
import type { AppId } from '../domain/app/app.js';
import type { PatternCandidateRepository } from '../domain/ports/pattern-candidates.js';
import {
  materializedSkillDirectoryNameFor,
  type SkillCatalogItem,
} from '../domain/skills/skills.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { formatNotApprovedMessage } from '../shared/user-visible-messages.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import type { TaskHandler } from './ipc-types.js';
import { startSkillPermissionReview } from './ipc-skill-permission-review.js';
import {
  formatArgvForDisplay,
  skillInstallCommandDisplayName,
} from './skill-install-display.js';
import {
  boundedSkillInstallFailureReason,
  collectInstalledSkillAssets,
  discoverInstalledSkillRoots,
  installedSkillContext,
  reportUnattemptedSkillRoots,
  rollbackFreshInstallBinding,
  rollbackInstalledSkillReplacement,
  safeInstallerEnv,
  withSkillMaterializationLock,
  snapshotInstalledSkill,
  skillInstallCommandReceipt,
  skillNameForReceipt,
  type ApprovedCommandSkillInstallResult,
} from './skill-install-assets.js';
import { parseSkillPackageAssets } from './skill-package-ipc.js';
import { claimPatternCandidateForSkillProposal } from './pattern-candidate-skill-proposal.js';
import {
  redactCommandOutput,
  sanitizedStringList,
} from './skill-install-command-sanitization.js';
const pendingSkillInstallCommandReviews = new Set<string>();
const pendingSkillPackageReviews = new Set<string>();

type SkillInstallRuntimeDeps = {
  getStorage: () => {
    repositories: {
      skills: ConstructorParameters<typeof SkillService>[0];
      patternCandidates?: PatternCandidateRepository;
    };
    skillArtifacts: ConstructorParameters<typeof SkillService>[1];
  };
  logInfo: (context: Record<string, unknown>, message: string) => void;
  logError: (context: Record<string, unknown>, message: string) => void;
  syncApprovedCapabilitySettings: (appId: AppId) => Promise<void>;
};

type ApprovedCommandRunner = NonNullable<
  Parameters<TaskHandler>[0]['deps']['runApprovedCommand']
>;
let runtimeDeps: SkillInstallRuntimeDeps | null = null;

export function configureSkillInstallHandlers(deps: SkillInstallRuntimeDeps) {
  runtimeDeps = deps;
}

function getRuntimeDeps(): SkillInstallRuntimeDeps {
  if (!runtimeDeps) {
    throw new Error('Skill install handlers are not configured.');
  }
  return runtimeDeps;
}

function createContextTaskResponder(context: Parameters<TaskHandler>[0]) {
  return createTaskResponder(
    context.sourceAgentFolder,
    context.data.taskId,
    context.data.authThreadId,
    context.data.responseKeyId,
  );
}

export const requestSkillProposalHandler: TaskHandler = async (context) => {
  await requestSkillPackageHandler(context, {
    requestKind: 'Skill proposal',
    fallbackName: 'agent-created-skill',
    requestToolName: 'request_skill_proposal',
  });
};

export const requestSkillInstallHandler: TaskHandler = async (context) => {
  const payload = context.data.payload || {};
  const installCommandArgv = sanitizedStringList(
    Array.isArray(payload.installCommandArgv) ? payload.installCommandArgv : [],
  );
  const hasPackageFiles =
    Array.isArray(payload.files) && payload.files.length > 0;
  if (installCommandArgv.length > 0 && hasPackageFiles) {
    const { reject } = createContextTaskResponder(context);
    reject(
      'Skill install requests must use either files or installCommandArgv, not both.',
      'invalid_request',
    );
    return;
  }
  if (installCommandArgv.length > 0 && !hasPackageFiles) {
    await requestSkillInstallCommandHandler(context, installCommandArgv);
    return;
  }
  await requestSkillPackageHandler(context, {
    requestKind: 'Skill install',
    fallbackName: 'installed-skill',
    requestToolName: 'request_skill_install',
  });
};

const requestSkillInstallCommandHandler = async (
  context: Parameters<TaskHandler>[0],
  installCommandArgv: string[],
) => {
  const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
  const { accept, acceptData, reject } = createContextTaskResponder(context);
  const payload = data.payload || {};
  if (!data.appId) {
    reject('Skill install requests require signed app scope.', 'forbidden');
    return;
  }
  const reason = toTrimmedString(payload.reason, { maxLen: 2000 }) || '';
  if (!reason) {
    reject('Missing required field: reason.', 'invalid_request');
    return;
  }
  const requestedTargetJid = validateSameChannelApprovalTarget({
    data,
    sourceAgentFolderJids,
    requestKind: 'Skill install',
    reject,
  });
  if (!requestedTargetJid) return;
  if (
    typeof deps.requestPermissionApproval !== 'function' ||
    typeof deps.sendMessage !== 'function' ||
    typeof deps.runApprovedCommand !== 'function'
  ) {
    reject(
      'Skill install requests require a configured approval and command execution surface.',
      'preflight_failed',
    );
    return;
  }

  const commandSummary = formatArgvForDisplay(installCommandArgv);
  const displayName = skillInstallCommandDisplayName(payload, commandSummary);
  const pendingKey = [
    data.appId,
    sourceAgentFolder,
    requestedTargetJid,
    data.authThreadId || '',
    displayName,
    installCommandArgv.join('\0'),
  ].join('\n');
  if (pendingSkillInstallCommandReviews.has(pendingKey)) {
    accept(
      `${displayName} is already waiting for approval in this chat.`,
      'skill_install_already_pending',
    );
    return;
  }
  pendingSkillInstallCommandReviews.add(pendingKey);
  getRuntimeDeps().logInfo(
    {
      appId: data.appId,
      sourceAgentFolder,
      targetJid: requestedTargetJid,
      threadId: data.authThreadId,
      toolName: 'request_skill_install',
      displayName,
      commandSummary,
      decision: 'requested',
    },
    'Skill install requested',
  );
  void completeSkillInstallCommandReview({
    context,
    commandSummary,
    displayName,
    installCommandArgv,
    pendingKey,
    reason,
    responder: { acceptData, reject },
    targetJid: requestedTargetJid,
  });
};

async function completeSkillInstallCommandReview(input: {
  context: Parameters<TaskHandler>[0];
  commandSummary: string;
  displayName: string;
  installCommandArgv: string[];
  pendingKey: string;
  reason: string;
  responder: Pick<
    ReturnType<typeof createTaskResponder>,
    'acceptData' | 'reject'
  >;
  targetJid: string;
}) {
  const { context } = input;
  const { data, deps, sourceAgentFolder } = context;
  try {
    const decision = await deps.requestPermissionApproval({
      requestId: `skill-install-command-${globalThis.crypto.randomUUID()}`,
      appId: data.appId as never,
      agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder) as never,
      sourceAgentFolder,
      targetJid: input.targetJid,
      threadId: data.authThreadId,
      providerAccountId: data.providerAccountId,
      decisionPolicy: 'same_channel',
      decisionOptions: ['allow_once', 'cancel'],
      toolName: 'request_skill_install',
      displayName: input.displayName,
      title: 'Install skill for this agent',
      description:
        'Only configured approvers can decide this request. Approval lets the agent prepare or import the skill package, then makes the skill available to this agent.',
      decisionReason: input.reason,
      toolInput: {
        installCommandArgv: input.installCommandArgv,
        commandSummary: input.commandSummary,
        activation: 'current_and_future_sessions',
        effect:
          'prepares_or_imports_skill_package_and_enables_skill_after_approval',
      },
    });
    getRuntimeDeps().logInfo(
      {
        appId: data.appId,
        sourceAgentFolder,
        targetJid: input.targetJid,
        threadId: data.authThreadId,
        toolName: 'request_skill_install',
        displayName: input.displayName,
        commandSummary: input.commandSummary,
        decision: decision.approved ? 'allowed' : 'denied',
        decidedBy: decision.decidedBy,
      },
      'Skill install decided',
    );
    if (!decision.approved || !decision.decidedBy) {
      const message = formatNotApprovedMessage({
        action: 'install',
        noun: 'skill',
        name: input.displayName,
        reason: decision.reason,
      });
      input.responder.reject(message, 'permission_denied');
      await deps.sendMessage(
        input.targetJid,
        message,
        skillInstallMessageOptions(data),
      );
      return;
    }
    const runApprovedCommand = deps.runApprovedCommand;
    if (!runApprovedCommand) {
      throw new Error('Skill install command runner is not configured.');
    }
    const installed = await installSkillFromApprovedCommand({
      appId: data.appId as never,
      agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder) as never,
      sourceAgentFolder,
      installCommandArgv: input.installCommandArgv,
      requiredEnvVars: sanitizedStringList(
        Array.isArray(data.payload?.requiredEnvVars)
          ? data.payload.requiredEnvVars
          : [],
      ),
      runApprovedCommand,
      installedBy: decision.decidedBy,
    });
    const message = skillInstallCommandReceipt(installed);
    if (installed.skills.length > 0) {
      await deps.sendMessage(
        input.targetJid,
        skillInstallCommandReceipt({ ...installed, failed: [] }),
        skillInstallMessageOptions(data),
      );
    }
    if (installed.installed.length === 0) {
      input.responder.reject(message, 'skill_install_failed');
      return;
    }
    input.responder.acceptData(
      message,
      installedSkillContext(installed.installed),
      'skill_installed',
    );
    getRuntimeDeps().logInfo(
      {
        appId: data.appId,
        sourceAgentFolder,
        targetJid: input.targetJid,
        threadId: data.authThreadId,
        toolName: 'request_skill_install',
        displayName: input.displayName,
        commandSummary: input.commandSummary,
        skillIds: installed.skills.map((skill) => skill.id),
        skillNames: installed.skills.map((skill) => skill.name),
        failedSkills: installed.failed,
        skippedBeyondLimit: installed.skippedBeyondLimit,
        requiredEnvVars: [
          ...new Set(
            installed.skills.flatMap((skill) => skill.requiredEnvVars ?? []),
          ),
        ],
      },
      'Skill install completed',
    );
  } catch (err) {
    getRuntimeDeps().logError(
      { err, sourceAgentFolder, toolName: 'request_skill_install' },
      'Skill install command review failed',
    );
    const message =
      'The skill could not be installed. Explain this in plain language and say you can try again after the setup issue is fixed.';
    input.responder.reject(message, 'permission_review_failed');
  } finally {
    pendingSkillInstallCommandReviews.delete(input.pendingKey);
  }
}

const requestSkillPackageHandler = async (
  context: Parameters<TaskHandler>[0],
  input: {
    requestKind: string;
    fallbackName: string;
    requestToolName: 'request_skill_install' | 'request_skill_proposal';
  },
) => {
  const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
  const { accept, acceptData, reject } = createContextTaskResponder(context);
  const payload = data.payload || {};
  if (!data.appId) {
    reject(
      `${input.requestKind} requests require signed app scope.`,
      'forbidden',
    );
    return;
  }
  const reason = toTrimmedString(payload.reason, { maxLen: 2000 }) || '';
  if (!reason) {
    reject('Missing required field: reason.', 'invalid_request');
    return;
  }
  const requestedTargetJid = validateSameChannelApprovalTarget({
    data,
    sourceAgentFolderJids,
    requestKind: input.requestKind,
    reject,
  });
  if (!requestedTargetJid) return;
  if (
    typeof deps.requestPermissionApproval !== 'function' ||
    typeof deps.sendMessage !== 'function'
  ) {
    reject(
      `${input.requestKind} requests require a configured approval surface.`,
      'preflight_failed',
    );
    return;
  }

  const parsed = parseSkillPackageAssets(payload.files);
  if (!parsed.ok) {
    reject(
      skillPackageParseError(input.requestToolName, parsed.error),
      'invalid_request',
    );
    return;
  }

  const pendingKey = [
    data.appId,
    sourceAgentFolder,
    requestedTargetJid,
    data.authThreadId || '',
    input.requestToolName,
    parsed.fileSummaries
      .map((summary) => `${summary.path}\0${summary.fingerprint}`)
      .sort()
      .join('\0'),
  ].join('\n');
  if (pendingSkillPackageReviews.has(pendingKey)) {
    accept(
      `${input.requestKind} for this skill package is already waiting for approval in this chat.`,
      'skill_package_already_pending',
    );
    return;
  }
  pendingSkillPackageReviews.add(pendingKey);

  try {
    const storage = getRuntimeDeps().getStorage();
    const patternCandidateId = toTrimmedString(payload.patternCandidateId, {
      maxLen: 512,
    });
    let patternLifecycle: Record<string, () => Promise<void>> | undefined;
    if (patternCandidateId && storage.repositories.patternCandidates) {
      const claim = await claimPatternCandidateForSkillProposal({
        repo: storage.repositories.patternCandidates,
        candidateId: patternCandidateId,
        appId: data.appId,
        sourceAgentFolder,
        targetJid: requestedTargetJid,
        memoryUserId: data.memoryUserId,
      });
      if (!claim.ok) {
        pendingSkillPackageReviews.delete(pendingKey);
        reject(claim.error, claim.code);
        return;
      }
      patternLifecycle = claim.lifecycle;
    }
    const service = new SkillService(
      storage.repositories.skills,
      storage.skillArtifacts,
    );
    const requiredEnvVars = sanitizedStringList([
      ...parsed.metadata.requiredEnvVars,
      ...(Array.isArray(payload.requiredEnvVars)
        ? payload.requiredEnvVars
        : []),
    ]);
    startSkillPermissionReview({
      deps,
      responder: { acceptData, reject },
      logError: getRuntimeDeps().logError,
      service,
      syncApprovedCapabilitySettings:
        getRuntimeDeps().syncApprovedCapabilitySettings,
      appId: data.appId as never,
      agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder) as never,
      sourceAgentFolder,
      targetJid: requestedTargetJid,
      threadId: data.authThreadId,
      providerAccountId: data.providerAccountId,
      skill: {
        name: parsed.metadata.name ?? input.fallbackName ?? 'requested-skill',
        description: parsed.metadata.description,
        requiredEnvVars,
      },
      assets: parsed.assets,
      fileSummaries: parsed.fileSummaries.map(
        ({ path, sizeBytes, fingerprint }) => ({
          path,
          sizeBytes,
          fingerprint,
        }),
      ),
      skillMarkdownPreview: {
        path: parsed.skillMarkdownPreview.path,
        content: parsed.skillMarkdownPreview.content,
        truncated: parsed.skillMarkdownPreview.truncated,
      },
      totalSizeBytes: parsed.totalSizeBytes,
      reason,
      requestToolName: input.requestToolName,
      ...patternLifecycle,
      onSettled: () => {
        pendingSkillPackageReviews.delete(pendingKey);
      },
    });
  } catch (err) {
    pendingSkillPackageReviews.delete(pendingKey);
    getRuntimeDeps().logError(
      { err, sourceAgentFolder, toolName: input.requestToolName },
      `${input.requestKind} request failed`,
    );
    reject(
      'The skill request could not be completed. Explain this in plain language and say you can try again after the setup issue is fixed.',
      'invalid_request',
    );
  }
};

function skillInstallMessageOptions(data: Parameters<TaskHandler>[0]['data']) {
  return data.authThreadId || data.providerAccountId
    ? {
        ...(data.authThreadId ? { threadId: data.authThreadId } : {}),
        ...(data.providerAccountId
          ? { providerAccountId: data.providerAccountId }
          : {}),
      }
    : undefined;
}

function validateSameChannelApprovalTarget(input: {
  data: Parameters<TaskHandler>[0]['data'];
  sourceAgentFolderJids: string[];
  requestKind: string;
  reject: (error: string, code?: string, details?: string[]) => void;
}): string | null {
  const requestedTargetJid = toTrimmedString(input.data.chatJid, {
    maxLen: 512,
  });
  const targetOverride = toTrimmedString(
    input.data.targetJid || input.data.jid,
    {
      maxLen: 512,
    },
  );
  if (targetOverride && targetOverride !== requestedTargetJid) {
    input.reject(
      `${input.requestKind} requests must use the originating chat as the approval target.`,
      'forbidden',
    );
    return null;
  }
  if (
    !requestedTargetJid ||
    !input.sourceAgentFolderJids.includes(requestedTargetJid)
  ) {
    input.reject(
      `${input.requestKind} requests must include the originating chat for this agent.`,
      'forbidden',
    );
    return null;
  }
  return requestedTargetJid;
}

function skillPackageParseError(
  requestToolName: 'request_skill_install' | 'request_skill_proposal',
  error: string,
): string {
  if (requestToolName !== 'request_skill_install') return error;
  if (!error.toLowerCase().includes('files')) return error;
  return 'Skill install needs a staged skill package with SKILL.md files. Provide the files field or use the admin upload path.';
}

async function installSkillFromApprovedCommand(input: {
  appId: AppId;
  agentId: AgentId;
  sourceAgentFolder: string;
  installCommandArgv: string[];
  requiredEnvVars: string[];
  runApprovedCommand: ApprovedCommandRunner;
  installedBy: string;
}): Promise<ApprovedCommandSkillInstallResult> {
  const storage = getRuntimeDeps().getStorage();
  const stagingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-skill-install-'),
  );
  try {
    await input.runApprovedCommand({
      argv: input.installCommandArgv,
      cwd: stagingDir,
      env: safeInstallerEnv(process.env),
      timeoutMs: 120_000,
      redactOutput: redactCommandOutput,
    });
    const discovery = discoverInstalledSkillRoots(stagingDir);
    const service = new SkillService(
      storage.repositories.skills,
      storage.skillArtifacts,
    );
    const result: ApprovedCommandSkillInstallResult = {
      skills: [],
      failed: [],
      skippedBeyondLimit: discovery.skippedBeyondLimit,
      installed: [],
    };
    const installedMaterializationKeys = new Set<string>();
    for (const root of discovery.roots) {
      let name = root === stagingDir ? 'installed-skill' : path.basename(root);
      try {
        const assets = collectInstalledSkillAssets(root);
        name = skillNameForReceipt(assets, name);
        const materializationKey =
          materializedSkillDirectoryNameFor(name).toLowerCase();
        if (installedMaterializationKeys.has(materializationKey)) {
          throw new Error(`Duplicate skill name: ${name}.`);
        }
        // Install-time collision validation (trace defect 3): fail this
        // skill's install honestly instead of blowing up the next spawn.
        const collision = await service.installMaterializationCollisionForAgent(
          {
            appId: input.appId,
            agentId: input.agentId,
            name,
          },
        );
        if (collision) {
          throw new Error(collision);
        }
        // One critical section per key: snapshot→install→bind→reread→sync,
        // and on failure the compensating rollback — a queued same-name
        // writer must never observe a failed intermediate state.
        const outcome = await withSkillMaterializationLock(
          materializationKey,
          async (): Promise<
            | { kind: 'installed'; skill: SkillCatalogItem }
            | {
                kind: 'failed';
                failedName: string;
                reason: string;
                stopAfterFailure: boolean;
              }
          > => {
            let skill: SkillCatalogItem | undefined;
            let syncAttempted = false;
            const previousSkill = await snapshotInstalledSkill({
              appId: input.appId,
              agentId: input.agentId,
              name,
              skills: storage.repositories.skills,
              artifacts: storage.skillArtifacts,
            });
            try {
              skill = await service.installSkill({
                appId: input.appId,
                agentId: input.agentId,
                fallbackName: name,
                createdBy: input.installedBy,
                requiredEnvVars: input.requiredEnvVars,
                assets,
              });
              // Re-read the persisted row BEFORE binding: if the bind fails,
              // compensation must compare against what storage actually
              // returns (drivers can normalize fields on read).
              skill =
                (await storage.repositories.skills.getSkill(skill.id)) ?? skill;
              await service.bindSkillToAgent({
                appId: input.appId,
                agentId: input.agentId,
                skillId: skill.id,
              });
              syncAttempted = true;
              await getRuntimeDeps().syncApprovedCapabilitySettings(
                input.appId,
              );
              return { kind: 'installed', skill };
            } catch (err) {
              const reason = boundedSkillInstallFailureReason(err);
              if (previousSkill) {
                const rollback = await rollbackInstalledSkillReplacement({
                  reason,
                  snapshot: previousSkill,
                  attemptedAssets: assets,
                  skills: storage.repositories.skills,
                  artifacts: storage.skillArtifacts,
                  syncAfterRestore: () =>
                    getRuntimeDeps().syncApprovedCapabilitySettings(
                      input.appId,
                    ),
                });
                return {
                  kind: 'failed',
                  failedName: skill?.name ?? name,
                  reason: rollback.reason,
                  stopAfterFailure: rollback.stopAfterFailure,
                };
              }
              if (skill) {
                const installedSkill = skill;
                const cleanup = await rollbackFreshInstallBinding({
                  reason,
                  syncAttempted,
                  rollbackBinding: () =>
                    service.rollbackInstalledSkillBinding({
                      appId: input.appId,
                      agentId: input.agentId,
                      skillId: installedSkill.id,
                    }),
                  isBindingActive: async () =>
                    (
                      await service.resolveLocalSkillsForAgent({
                        appId: input.appId,
                        agentId: input.agentId,
                      })
                    ).some(
                      (activeSkill) => activeSkill.id === installedSkill.id,
                    ),
                  sync: () =>
                    getRuntimeDeps().syncApprovedCapabilitySettings(
                      input.appId,
                    ),
                });
                if (cleanup.keepAsInstalled) {
                  return { kind: 'installed', skill: installedSkill };
                }
                return {
                  kind: 'failed',
                  failedName: installedSkill.name,
                  reason: cleanup.reason,
                  stopAfterFailure: cleanup.stopAfterFailure,
                };
              }
              return {
                kind: 'failed',
                failedName: name,
                reason,
                stopAfterFailure: false,
              };
            }
          },
        );
        if (outcome.kind === 'installed') {
          installedMaterializationKeys.add(materializationKey);
          result.skills.push(outcome.skill);
          result.installed.push({ skill: outcome.skill, assets });
          continue;
        }
        const reason = outcome.reason;
        result.failed.push({
          name: outcome.failedName,
          reason,
        });
        getRuntimeDeps().logError(
          {
            appId: input.appId,
            agentId: input.agentId,
            skillName: outcome.failedName ?? name,
            reason,
          },
          'Skill install failed for skill',
        );
        if (outcome.stopAfterFailure) {
          reportUnattemptedSkillRoots(result, discovery.roots, root);
          break;
        }
      } catch (err) {
        // Errors outside the critical section (asset collection, duplicate
        // names, snapshot failure) have no partial state to compensate.
        const reason = boundedSkillInstallFailureReason(err);
        result.failed.push({
          name,
          reason,
        });
        getRuntimeDeps().logError(
          {
            appId: input.appId,
            agentId: input.agentId,
            skillName: name,
            reason,
          },
          'Skill install failed for skill',
        );
      }
    }
    return result;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}
