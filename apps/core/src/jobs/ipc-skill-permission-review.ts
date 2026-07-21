import { materializedSkillDirectoryNameFor } from '../domain/skills/skills.js';
import {
  skillNameForReceipt,
  withSkillMaterializationLock,
} from './skill-install-assets.js';
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
  logError?: (context: Record<string, unknown>, message: string) => void;
  service: SkillService;
  syncApprovedCapabilitySettings: (appId: AppId) => Promise<void>;
  appId: AppId;
  agentId: AgentId;
  sourceAgentFolder: string;
  targetJid: string;
  threadId?: string;
  providerAccountId?: string;
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
    fingerprint: string;
  }>;
  skillMarkdownPreview: {
    path: string;
    content: string;
    truncated: boolean;
  };
  totalSizeBytes: number;
  reason: string;
  requestToolName: 'request_skill_install' | 'request_skill_proposal';
  onReviewStarted?: () => Promise<void>;
  onApproved?: () => Promise<void>;
  onRejected?: () => Promise<void>;
  onBlocked?: () => Promise<void>;
  onSettled?: () => void;
}): void {
  void completeSkillPermissionReview(input)
    .catch(async (err) => {
      input.logError?.(
        {
          appId: input.appId,
          agentId: input.agentId,
          skillName: input.skill.name,
          toolName: input.requestToolName,
          err,
        },
        'Skill permission review failed',
      );
      await notifyLifecycle(input.onBlocked);
      input.responder.reject(
        'The skill could not be installed. Explain this in plain language and say you can try again after the setup issue is fixed.',
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
  // Install-time collision validation (trace defect 3): fail the install with
  // an honest receipt now instead of blowing up the agent's next spawn.
  const collision = await input.service.installMaterializationCollisionForAgent(
    {
      appId: input.appId,
      agentId: input.agentId,
      name: skillNameForReceipt(input.assets, input.skill.name),
      ...(input.skill.id ? { skillId: input.skill.id as never } : {}),
    },
  );
  if (collision) {
    await notifyLifecycle(input.onBlocked);
    input.responder.reject(collision, 'skill_materialization_collision');
    return;
  }
  await notifyLifecycle(input.onReviewStarted);
  const decision = await input.deps.requestPermissionApproval({
    requestId: `skill-${globalThis.crypto.randomUUID()}`,
    appId: input.appId,
    agentId: input.agentId,
    sourceAgentFolder: input.sourceAgentFolder,
    targetJid: input.targetJid,
    threadId: input.threadId,
    providerAccountId: input.providerAccountId,
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
    interaction: skillReviewInteraction(input),
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
      files: input.fileSummaries.map(({ path, sizeBytes, fingerprint }) => ({
        path,
        sizeBytes,
        contentHash: fingerprint,
      })),
      totalSizeBytes: input.totalSizeBytes,
      activation: 'current_and_future_sessions',
    },
  });
  if (!decision.approved) {
    await notifyLifecycle(input.onRejected);
    return rejectSkillRequestFromPermission(input, decision.reason);
  }
  if (!decision.decidedBy) {
    await notifyLifecycle(input.onRejected);
    return rejectSkillRequestFromPermission(
      input,
      'missing approving principal',
    );
  }

  let installedSkill: SkillCatalogItem | undefined;
  try {
    // The full install→bind→sync→compensation sequence holds the keyed lock
    // so a concurrent same-name writer can never interleave with a partial
    // state from this path.
    installedSkill = await withSkillMaterializationLock(
      materializedSkillDirectoryNameFor(
        skillNameForReceipt(input.assets, input.skill.name),
      ).toLowerCase(),
      async () => {
        const collision =
          await input.service.installMaterializationCollisionForAgent({
            appId: input.appId,
            agentId: input.agentId,
            name: skillNameForReceipt(input.assets, input.skill.name),
            ...(input.skill.id ? { skillId: input.skill.id as never } : {}),
          });
        if (collision)
          throw new InstallMaterializationCollisionError(collision);
        let installedSkillId: string | undefined;
        try {
          const installed = await input.service.installSkill({
            appId: input.appId,
            agentId: input.agentId,
            fallbackName: input.skill.name,
            createdBy: decision.decidedBy,
            requiredEnvVars: input.skill.requiredEnvVars,
            assets: input.assets,
          });
          installedSkillId = installed.id;
          await input.service.bindSkillToAgent({
            appId: input.appId,
            agentId: input.agentId,
            skillId: installed.id,
          });
          await input.syncApprovedCapabilitySettings(input.appId);
          return installed;
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
      },
    );
  } catch (err) {
    await notifyLifecycle(input.onBlocked);
    if (err instanceof InstallMaterializationCollisionError) {
      input.responder.reject(err.message, 'skill_materialization_collision');
      return;
    }
    throw err;
  }
  const sameSessionContext = buildInstalledSkillSameSessionContext(
    input,
    installedSkill,
  );
  await notifyLifecycle(input.onApproved);
  const action = 'Installed';
  await input.deps.sendMessage(
    input.targetJid,
    skillApprovalMessage(
      action,
      installedSkill.name,
      installedSkill.requiredEnvVars,
    ),
    skillReviewMessageOptions(input),
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

class InstallMaterializationCollisionError extends Error {}

function skillReviewMessageOptions(
  input: Parameters<typeof startSkillPermissionReview>[0],
) {
  return input.threadId || input.providerAccountId
    ? {
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.providerAccountId
          ? { providerAccountId: input.providerAccountId }
          : {}),
        agentId: input.agentId,
      }
    : undefined;
}

async function notifyLifecycle(
  callback: (() => Promise<void>) | undefined,
): Promise<void> {
  try {
    await callback?.();
  } catch {
    // Candidate proposal-status bookkeeping must not break the skill review flow.
  }
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
    skillReviewMessageOptions(input),
  );
  input.responder.reject(message, 'permission_denied');
}

function skillReviewInteraction(
  input: Parameters<typeof startSkillPermissionReview>[0],
) {
  const skillMarkdown = input.assets.find((asset) => asset.path === 'SKILL.md');
  const skillMarkdownSummary = input.fileSummaries.find(
    (summary) => summary.path === 'SKILL.md',
  );
  return {
    id: `skill-review-${globalThis.crypto.randomUUID()}`,
    title: `Install skill ${input.skill.name}`,
    body: input.reason,
    severity: 'warning' as const,
    requestContext: {
      sourceAgentFolder: input.sourceAgentFolder,
      targetJid: input.targetJid,
      threadId: input.threadId,
      providerAccountId: input.providerAccountId,
      toolName: input.requestToolName,
      capabilityType: 'skill',
      capabilityId: input.skill.id,
      capabilityDisplayName: input.skill.name,
    },
    details: [
      { label: 'Skill', value: input.skill.name },
      { label: 'Activation', value: 'current and future sessions' },
      { label: 'Package size', value: `${input.totalSizeBytes} bytes` },
      ...(input.skill.requiredEnvVars?.length
        ? [
            {
              label: 'Credentials',
              value:
                'Required before some skill actions can run; add them in Credential Center.',
            },
          ]
        : []),
    ],
    files: [
      ...(skillMarkdown
        ? [
            {
              path: skillMarkdown.path,
              sizeBytes: skillMarkdownSummary?.sizeBytes,
              contentHash: skillMarkdownSummary?.fingerprint,
              contentType: skillMarkdown.contentType ?? 'text/markdown',
              preview: Buffer.from(skillMarkdown.content).toString('utf-8'),
              truncated: false,
            },
          ]
        : []),
      ...input.fileSummaries
        .filter((summary) => summary.path !== 'SKILL.md')
        .map((summary) => ({
          path: summary.path,
          sizeBytes: summary.sizeBytes,
          contentHash: summary.fingerprint,
        })),
    ],
  };
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
