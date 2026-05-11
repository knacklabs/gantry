import { SkillDraftService } from '../application/skills/skill-draft-service.js';
import type { AgentId } from '../domain/agent/agent.js';
import type { AppId } from '../domain/app/app.js';
import type { TaskHandler } from './ipc-types.js';
import { createTaskResponder } from './ipc-shared.js';

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
  requestToolName: 'request_skill_proposal';
}): void {
  void completeSkillPermissionReview(input).catch((err) => {
    input.responder.reject(
      err instanceof Error ? err.message : 'Skill permission review failed.',
      'permission_review_failed',
    );
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
    toolName: input.requestToolName,
    displayName: `Skill: ${input.skill.name}`,
    title: 'Approve skill for this agent',
    description:
      'Only configured approvers can decide this request. Approving binds this skill, returns it to the current agent run, and materializes it for future runs.',
    decisionReason: input.reason,
    toolInput: {
      skillId: input.skill.id,
      name: input.skill.name,
      description: input.skill.description,
      packageContentHash: input.skill.contentHash,
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

  await input.service.approveDraft({
    appId: input.appId,
    skillId: input.skill.id as never,
    approvedBy: decision.decidedBy,
  });
  await input.service.bindSkillToAgent({
    appId: input.appId,
    agentId: input.agentId,
    skillId: input.skill.id as never,
  });
  await input.syncApprovedCapabilitySettings(input.appId);
  const sameSessionContext = buildApprovedSkillSameSessionContext(input);
  await input.deps.sendMessage(
    input.targetJid,
    `Approved skill ${input.skill.name}. It has been returned to the running agent and will also be available in future sessions.`,
    input.threadId ? { threadId: input.threadId } : undefined,
  );
  input.responder.acceptData(
    `Approved skill ${input.skill.name}. It is available in this current run and future sessions.`,
    sameSessionContext,
    'skill_approved',
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
  await input.deps.sendMessage(
    input.targetJid,
    `Rejected skill ${input.skill.name}: ${reason || 'not approved'}.`,
    input.threadId ? { threadId: input.threadId } : undefined,
  );
  input.responder.reject(
    `Rejected skill ${input.skill.name}: ${reason || 'not approved'}.`,
    'permission_denied',
  );
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
