import type { AppId } from '../../domain/app/app.js';
import type { AgentHarness } from '../../shared/agent-engine.js';

export interface CreateOnboardingSetupRequestDto {
  appId: AppId;
  actorId: string;
  idempotencyKey: string;
  name: string;
  title: string;
  responsibilities: string[];
  modelAlias: string;
  agentHarness: AgentHarness;
}

export interface OnboardingSetupResponseDto {
  setupId: string;
  agentId: string;
  agentName: string;
  desiredStateRevision: number;
  replayed: boolean;
}

export type OnboardingProgress = {
  modelValidated?: boolean;
  workspaceConnected?: boolean;
  assignmentReady?: boolean;
  verificationSatisfied?: boolean;
  projectionCompleted?: boolean;
};
