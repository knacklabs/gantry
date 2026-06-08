import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SkillService } from '../application/skills/skill-service.js';
import type { AgentId } from '../domain/agent/agent.js';
import type { AppId } from '../domain/app/app.js';
import type { SkillCatalogItem } from '../domain/skills/skills.js';
import { memoryAgentIdForGroupFolder } from '../memory/app-memory-boundaries.js';
import {
  formatAvailableNowMessage,
  formatNotApprovedMessage,
} from '../shared/user-visible-messages.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import type { TaskHandler } from './ipc-types.js';
import { startSkillPermissionReview } from './ipc-skill-permission-review.js';
import {
  formatArgvForDisplay,
  skillInstallCommandDisplayName,
} from './skill-install-display.js';
import { parseSkillPackageAssets } from './skill-package-ipc.js';

const pendingSkillInstallCommandReviews = new Set<string>();
const pendingSkillPackageReviews = new Set<string>();

type SkillInstallRuntimeDeps = {
  getStorage: () => {
    repositories: {
      skills: ConstructorParameters<typeof SkillService>[0];
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
      agentId: memoryAgentIdForGroupFolder(sourceAgentFolder) as never,
      sourceAgentFolder,
      targetJid: input.targetJid,
      threadId: data.authThreadId,
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
        data.authThreadId ? { threadId: data.authThreadId } : undefined,
      );
      return;
    }
    const runApprovedCommand = deps.runApprovedCommand;
    if (!runApprovedCommand) {
      throw new Error('Skill install command runner is not configured.');
    }
    const installed = await installSkillFromApprovedCommand({
      appId: data.appId as never,
      agentId: memoryAgentIdForGroupFolder(sourceAgentFolder) as never,
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
    const message = skillInstallCommandSuccessMessage(
      installed.skill.name,
      installed.requiredEnvVars,
    );
    await deps.sendMessage(
      input.targetJid,
      message,
      data.authThreadId ? { threadId: data.authThreadId } : undefined,
    );
    input.responder.acceptData(
      message,
      {
        type: 'installed_skill_context',
        activation: 'current_and_future_sessions',
        skill: {
          id: installed.skill.id,
          name: installed.skill.name,
          description: installed.skill.description,
          requiredEnvVars: installed.requiredEnvVars,
        },
        requiredEnvVars: installed.requiredEnvVars,
        files: installed.assets.map((asset) => ({
          path: asset.path,
          ...(asset.contentType ? { contentType: asset.contentType } : {}),
          content: Buffer.from(asset.content).toString('utf-8'),
        })),
      },
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
        skillId: installed.skill.id,
        skillName: installed.skill.name,
        requiredEnvVars: installed.requiredEnvVars,
      },
      'Skill install completed',
    );
  } catch (err) {
    getRuntimeDeps().logError(
      { err, sourceAgentFolder, toolName: 'request_skill_install' },
      'Skill install command review failed',
    );
    const message = formatNotApprovedMessage({
      action: 'install',
      noun: 'skill',
      name: input.displayName,
      reason: err instanceof Error ? err.message : 'permission review failed',
    });
    input.responder.reject(message, 'permission_review_failed');
    await deps.sendMessage(
      input.targetJid,
      message,
      data.authThreadId ? { threadId: data.authThreadId } : undefined,
    );
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
      service,
      syncApprovedCapabilitySettings:
        getRuntimeDeps().syncApprovedCapabilitySettings,
      appId: data.appId as never,
      agentId: memoryAgentIdForGroupFolder(sourceAgentFolder) as never,
      sourceAgentFolder,
      targetJid: requestedTargetJid,
      threadId: data.authThreadId,
      skill: {
        name: parsed.metadata.name ?? input.fallbackName ?? 'requested-skill',
        description: parsed.metadata.description,
        requiredEnvVars,
      },
      assets: parsed.assets,
      fileSummaries: parsed.fileSummaries.map(({ path, sizeBytes }) => ({
        path,
        sizeBytes,
      })),
      skillMarkdownPreview: {
        path: parsed.skillMarkdownPreview.path,
        content: parsed.skillMarkdownPreview.content,
        truncated: parsed.skillMarkdownPreview.truncated,
      },
      totalSizeBytes: parsed.totalSizeBytes,
      reason,
      requestToolName: input.requestToolName,
      onSettled: () => {
        pendingSkillPackageReviews.delete(pendingKey);
      },
    });
  } catch (err) {
    pendingSkillPackageReviews.delete(pendingKey);
    reject(
      err instanceof Error
        ? err.message
        : `${input.requestKind} request failed.`,
      'invalid_request',
    );
  }
};

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
}): Promise<{
  skill: SkillCatalogItem;
  assets: Array<{ path: string; contentType?: string; content: Uint8Array }>;
  requiredEnvVars: string[];
}> {
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
    const assets = collectInstalledSkillAssets(stagingDir);
    const service = new SkillService(
      storage.repositories.skills,
      storage.skillArtifacts,
    );
    const installed = await service.installSkill({
      appId: input.appId,
      agentId: input.agentId,
      fallbackName: 'installed-skill',
      createdBy: input.installedBy,
      requiredEnvVars: input.requiredEnvVars,
      assets,
    });
    try {
      await service.bindSkillToAgent({
        appId: input.appId,
        agentId: input.agentId,
        skillId: installed.id,
      });
      await getRuntimeDeps().syncApprovedCapabilitySettings(input.appId);
      return {
        skill: installed,
        assets,
        requiredEnvVars: installed.requiredEnvVars ?? [],
      };
    } catch (err) {
      await service.rollbackInstalledSkillBinding({
        appId: input.appId,
        agentId: input.agentId,
        skillId: installed.id,
      });
      throw err;
    }
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function collectInstalledSkillAssets(
  stagingDir: string,
): Array<{ path: string; contentType?: string; content: Uint8Array }> {
  const skillMdPath = findSkillMarkdown(stagingDir);
  if (!skillMdPath) {
    throw new Error('Installer command did not produce a SKILL.md file.');
  }
  const root = path.dirname(skillMdPath);
  const assets: Array<{
    path: string;
    contentType?: string;
    content: Uint8Array;
  }> = [];
  let totalBytes = 0;
  for (const filePath of listPackageFiles(root)) {
    const rel = path.relative(root, filePath).split(path.sep).join('/');
    const stat = fs.statSync(filePath);
    totalBytes += stat.size;
    if (assets.length >= 50) break;
    if (totalBytes > 1_000_000) {
      throw new Error('Installed skill package is larger than 1 MB.');
    }
    assets.push({
      path: rel,
      content: fs.readFileSync(filePath),
    });
  }
  if (!assets.some((asset) => asset.path === 'SKILL.md')) {
    throw new Error('Installed skill package must include SKILL.md.');
  }
  return assets;
}

function findSkillMarkdown(root: string): string | null {
  const candidates = listPackageFiles(root)
    .filter((filePath) => path.basename(filePath) === 'SKILL.md')
    .sort((left, right) => left.length - right.length);
  return candidates[0] ?? null;
}

function listPackageFiles(root: string): string[] {
  const output: string[] = [];
  const ignored = new Set(['.git', 'node_modules', '.DS_Store']);
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        output.push(fullPath);
      }
    }
  };
  visit(root);
  return output.sort();
}

function safeInstallerEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  return env;
}

function skillInstallCommandSuccessMessage(
  skillName: string,
  requiredEnvVars: readonly string[],
): string {
  return formatAvailableNowMessage({
    action: 'Installed',
    noun: 'skill',
    name: skillName,
    requiredEnvVars,
  });
}

function redactCommandOutput(value: string): string {
  return value.replace(
    /[A-Za-z0-9_=-]*(TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_=-]*/gi,
    '<redacted>',
  );
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
