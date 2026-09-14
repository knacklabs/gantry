import { ApplicationError } from '../common/application-error.js';
import { stableSha256Json } from '../../shared/stable-hash.js';
import { isAgentHarness } from '../../shared/agent-engine.js';
import type {
  CreateOnboardingSetupRequestDto,
  OnboardingProgress,
  OnboardingSetupResponseDto,
} from './onboarding-setup.dto.js';
import type { OnboardingSetupRepository } from './onboarding-setup-repository.interface.js';

export class OnboardingSetupService {
  constructor(private readonly repository: OnboardingSetupRepository) {}

  async createOrResume(
    input: CreateOnboardingSetupRequestDto,
  ): Promise<OnboardingSetupResponseDto> {
    const normalized = {
      ...input,
      idempotencyKey: input.idempotencyKey.trim(),
      name: input.name.trim(),
      title: input.title.trim(),
      responsibilities: input.responsibilities
        .map((item) => item.trim())
        .filter(Boolean),
      modelAlias: input.modelAlias.trim(),
    };
    if (
      !normalized.idempotencyKey ||
      !normalized.name ||
      !normalized.title ||
      !normalized.modelAlias ||
      !isAgentHarness(normalized.agentHarness)
    ) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Complete employee, model, harness, and idempotency details are required.',
      );
    }
    return this.repository.createOrResume({
      ...normalized,
      requestHash: stableSha256Json({
        name: normalized.name,
        title: normalized.title,
        responsibilities: normalized.responsibilities,
        modelAlias: normalized.modelAlias,
        agentHarness: normalized.agentHarness,
      }),
    });
  }

  async updateProgress(input: {
    setupId: string;
    actorId: string;
    progress: OnboardingProgress;
  }): Promise<void> {
    await this.repository.updateProgress(input);
  }
}

export function invalidateOnboardingProgress(
  current: OnboardingProgress,
  changed: 'model' | 'workspace' | 'assignment',
): OnboardingProgress {
  if (changed === 'model') return {};
  if (changed === 'workspace') {
    return { modelValidated: current.modelValidated };
  }
  return {
    modelValidated: current.modelValidated,
    workspaceConnected: current.workspaceConnected,
  };
}
