import { SkillService } from '../application/skills/skill-service.js';
import type { AgentId } from '../domain/agent/agent.js';
import type { AppId } from '../domain/app/app.js';
import type { SkillCatalogItem } from '../domain/skills/skills.js';
import type { TaskHandler } from './ipc-types.js';
import { createTaskResponder } from './ipc-shared.js';
import {
  formatAvailableNowMessage,
  formatNotApprovedMessage,
} from '../shared/user-visible-messages.js';

export function startSkillPermissionReview(input: {
  deps: Parameters<TaskHandler>[0]['deps'];
  responder: Pick<
    ReturnType<typeof createTaskResponder>,
    'acceptData' | 'reject'
  >;
  service: SkillService;
  syncApprovedCapabilitySettings: (appId: AppId) => Promise<void>;
  appId: AppId;
  agentId: AgentId;
  sourceAgentFolder: string;
  targetJid: string;
  threadId?: string;
  skill: {
    id?: string;
    name: string;
    description?: string;
    requiredEnvVars?: string[];
  };
  assets: Array<{ path: string; contentType?: string; content: Uint8Array }>;
  fileSummaries: Array<{
    path: string;
    sizeBytes: number;
  }>;
  skillMarkdownPreview: {
    path: string;
    content: string;
    truncated: boolean;
  };
  totalSizeBytes: number;
  reason: string;
  requestToolName: 'request_skill_install' | 'request_skill_proposal';
  onSettled?: () => void;
}): void {
  void completeSkillPermissionReview(input)
    .catch((err) => {
      input.responder.reject(
        err instanceof Error ? err.message : 'Skill permission review failed.',
        'permission_review_failed',
      );
    })
    .finally(() => {
      input.onSettled?.();
    });
}

async function completeSkillPermissionReview(
  input: Parameters<typeof startSkillPermissionReview>[0],
): Promise<void> {
  const decision = await input.deps.requestPermissionApproval({
    requestId: `skill-${globalThis.crypto.randomUUID()}`,
    appId: input.appId,
    agentId: input.agentId,
    sourceAgentFolder: input.sourceAgentFolder,
    targetJid: input.targetJid,
    threadId: input.threadId,
    decisionPolicy: 'same_channel',
    decisionOptions: ['allow_once', 'cancel'],
    toolName: input.requestToolName,
    displayName: `Skill: ${input.skill.name}`,
    title:
      input.requestToolName === 'request_skill_install'
        ? 'Install skill for this agent'
        : 'Install proposed skill for this agent',
    description:
      input.requestToolName === 'request_skill_install'
        ? 'Only configured approvers can decide this request. Approval installs the skill and makes it available to this agent.'
        : 'Only configured approvers can decide this request. Approval makes the skill available to this agent.',
    decisionReason: input.reason,
    toolInput: {
      skillId: input.skill.id,
      name: input.skill.name,
      description: input.skill.description,
      requiredEnvVars: input.skill.requiredEnvVars ?? [],
      skillMarkdownPreview: {
        path: input.skillMarkdownPreview.path,
        content: input.skillMarkdownPreview.content,
        truncated: input.skillMarkdownPreview.truncated,
      },
      files: input.fileSummaries.map(({ path, sizeBytes }) => ({
        path,
        sizeBytes,
      })),
      totalSizeBytes: input.totalSizeBytes,
      activation: 'current_and_future_sessions',
    },
  });
  if (!decision.approved)
    return rejectSkillRequestFromPermission(input, decision.reason);
  if (!decision.decidedBy)
    return rejectSkillRequestFromPermission(
      input,
      'missing approving principal',
    );

  let installedSkillId: string | undefined;
  let installedSkill: SkillCatalogItem | undefined;
  try {
    const installed = await input.service.installSkill({
      appId: input.appId,
      agentId: input.agentId,
      fallbackName: input.skill.name,
      createdBy: decision.decidedBy,
      requiredEnvVars: input.skill.requiredEnvVars,
      assets: input.assets,
    });
    installedSkill = installed;
    installedSkillId = installed.id;
    await input.service.bindSkillToAgent({
      appId: input.appId,
      agentId: input.agentId,
      skillId: installed.id,
    });
    await input.syncApprovedCapabilitySettings(input.appId);
  } catch (err) {
    if (installedSkillId) {
      await input.service.rollbackInstalledSkillBinding({
        appId: input.appId,
        agentId: input.agentId,
        skillId: installedSkillId as never,
      });
    }
    throw err;
  }
  const sameSessionContext = buildInstalledSkillSameSessionContext(
    input,
    installedSkill,
  );
  const action = 'Installed';
  await input.deps.sendMessage(
    input.targetJid,
    skillApprovalMessage(
      action,
      installedSkill.name,
      installedSkill.requiredEnvVars,
    ),
    input.threadId ? { threadId: input.threadId } : undefined,
  );
  input.responder.acceptData(
    skillApprovalMessage(
      action,
      installedSkill.name,
      installedSkill.requiredEnvVars,
    ),
    sameSessionContext,
    'skill_installed',
  );
}

async function rejectSkillRequestFromPermission(
  input: Parameters<typeof startSkillPermissionReview>[0],
  reason?: string,
): Promise<void> {
  const message = formatNotApprovedMessage({
    action: 'install',
    noun: 'skill',
    name: input.skill.name,
    reason,
  });
  await input.deps.sendMessage(
    input.targetJid,
    message,
    input.threadId ? { threadId: input.threadId } : undefined,
  );
  input.responder.reject(message, 'permission_denied');
}

function buildInstalledSkillSameSessionContext(
  input: Parameters<typeof startSkillPermissionReview>[0],
  installedSkill: SkillCatalogItem,
) {
  const summariesByPath = new Map(
    input.fileSummaries.map((summary) => [summary.path, summary]),
  );
  return {
    type: 'installed_skill_context' as const,
    activation: 'current_and_future_sessions' as const,
    skill: {
      id: installedSkill.id,
      name: installedSkill.name,
      description: installedSkill.description,
      requiredEnvVars: installedSkill.requiredEnvVars ?? [],
    },
    requiredEnvVars: installedSkill.requiredEnvVars ?? [],
    files: input.assets.map((asset) => {
      const summary = summariesByPath.get(asset.path);
      return {
        path: asset.path,
        ...(asset.contentType ? { contentType: asset.contentType } : {}),
        content: Buffer.from(asset.content).toString('utf-8'),
        ...(summary ? { sizeBytes: summary.sizeBytes } : {}),
      };
    }),
  };
}

function skillApprovalMessage(
  action: string,
  skillName: string,
  requiredEnvVars?: readonly string[],
): string {
  return formatAvailableNowMessage({
    action,
    noun: 'skill',
    name: skillName,
    requiredEnvVars,
  });
}
