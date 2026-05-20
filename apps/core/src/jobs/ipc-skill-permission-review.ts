import { SkillDraftService } from '../application/skills/skill-draft-service.js';
import type { AgentId } from '../domain/agent/agent.js';
import type { AppId } from '../domain/app/app.js';
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
  service: SkillDraftService;
  syncApprovedCapabilitySettings: (appId: AppId) => Promise<void>;
  appId: AppId;
  agentId: AgentId;
  sourceAgentFolder: string;
  targetJid: string;
  threadId?: string;
  skill: {
    id: string;
    name: string;
    description?: string;
    contentHash?: string;
    requiredEnvVars?: string[];
  };
  assets: Array<{ path: string; contentType?: string; content: Uint8Array }>;
  fileSummaries: Array<{
    path: string;
    sizeBytes: number;
    contentHash: string;
  }>;
  skillMarkdownPreview: {
    path: string;
    content: string;
    truncated: boolean;
    contentHash: string;
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
        : 'Approve skill for this agent',
    description:
      input.requestToolName === 'request_skill_install'
        ? 'Only configured approvers can decide this request. Approval installs the skill and makes it available to this agent.'
        : 'Only configured approvers can decide this request. Approval makes the skill available to this agent.',
    decisionReason: input.reason,
    toolInput: {
      skillId: input.skill.id,
      name: input.skill.name,
      description: input.skill.description,
      packageContentHash: input.skill.contentHash,
      requiredEnvVars: input.skill.requiredEnvVars ?? [],
      skillMarkdownPreview: input.skillMarkdownPreview,
      files: input.fileSummaries,
      totalSizeBytes: input.totalSizeBytes,
      activation: 'current_and_future_sessions',
    },
  });
  if (!decision.approved)
    return rejectSkillDraftFromPermission(input, decision.reason);
  if (!decision.decidedBy)
    return rejectSkillDraftFromPermission(input, 'missing approving principal');

  let approvalApplied = false;
  try {
    await input.service.approveDraft({
      appId: input.appId,
      skillId: input.skill.id as never,
      approvedBy: decision.decidedBy,
    });
    approvalApplied = true;
    await input.service.bindSkillToAgent({
      appId: input.appId,
      agentId: input.agentId,
      skillId: input.skill.id as never,
    });
    await input.syncApprovedCapabilitySettings(input.appId);
  } catch (err) {
    if (approvalApplied) {
      await input.service.rollbackApprovedSkillBinding({
        appId: input.appId,
        agentId: input.agentId,
        skillId: input.skill.id as never,
      });
    }
    throw err;
  }
  const sameSessionContext = buildApprovedSkillSameSessionContext(input);
  const action =
    input.requestToolName === 'request_skill_install'
      ? 'Installed'
      : 'Approved';
  await input.deps.sendMessage(
    input.targetJid,
    skillApprovalMessage(action, input.skill.name, input.skill.requiredEnvVars),
    input.threadId ? { threadId: input.threadId } : undefined,
  );
  input.responder.acceptData(
    skillApprovalMessage(action, input.skill.name, input.skill.requiredEnvVars),
    sameSessionContext,
    input.requestToolName === 'request_skill_install'
      ? 'skill_installed'
      : 'skill_approved',
  );
}

async function rejectSkillDraftFromPermission(
  input: Parameters<typeof startSkillPermissionReview>[0],
  reason?: string,
): Promise<void> {
  await input.service.rejectDraft({
    appId: input.appId,
    skillId: input.skill.id as never,
    rejectedBy: 'permission_review',
  });
  const message = formatNotApprovedMessage({
    action:
      input.requestToolName === 'request_skill_install' ? 'install' : 'approve',
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

function buildApprovedSkillSameSessionContext(
  input: Parameters<typeof startSkillPermissionReview>[0],
) {
  const summariesByPath = new Map(
    input.fileSummaries.map((summary) => [summary.path, summary]),
  );
  return {
    type: 'approved_skill_context' as const,
    activation: 'current_and_future_sessions' as const,
    skill: input.skill,
    requiredEnvVars: input.skill.requiredEnvVars ?? [],
    files: input.assets.map((asset) => {
      const summary = summariesByPath.get(asset.path);
      return {
        path: asset.path,
        ...(asset.contentType ? { contentType: asset.contentType } : {}),
        content: Buffer.from(asset.content).toString('utf-8'),
        ...(summary
          ? { contentHash: summary.contentHash, sizeBytes: summary.sizeBytes }
          : {}),
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
