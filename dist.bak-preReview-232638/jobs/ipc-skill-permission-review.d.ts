import { SkillService } from '../application/skills/skill-service.js';
import type { AgentId } from '../domain/agent/agent.js';
import type { AppId } from '../domain/app/app.js';
import type { TaskHandler } from './ipc-types.js';
import { createTaskResponder } from './ipc-shared.js';
export declare function startSkillPermissionReview(input: {
    deps: Parameters<TaskHandler>[0]['deps'];
    responder: Pick<ReturnType<typeof createTaskResponder>, 'acceptData' | 'reject'>;
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
    assets: Array<{
        path: string;
        contentType?: string;
        content: Uint8Array;
    }>;
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
}): void;
