import { ApplicationError } from '../common/application-error.js';
import { stableSha256Json } from '../../shared/stable-hash.js';
import { isAgentHarness } from '../../shared/agent-engine.js';
import { resolveModelSelectionForWorkload } from '../../shared/model-catalog.js';
import { resolveExecutionRoute } from '../../shared/model-execution-route.js';
import type {
  CreateOnboardingSetupRequestDto,
  OnboardingProgress,
  OnboardingSetupResponseDto,
} from './onboarding-setup.dto.js';
import type { OnboardingSetupRepository } from './onboarding-setup-repository.interface.js';

export class OnboardingSetupService {
  constructor(
    private readonly repository: OnboardingSetupRepository,
    private readonly validateModel: (input: {
      appId: CreateOnboardingSetupRequestDto['appId'];
      modelAlias: string;
      providerId: string;
    }) => Promise<{ ok: boolean; message: string }>,
  ) {}

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
    const requestHash = stableSha256Json({
      name: normalized.name,
      title: normalized.title,
      responsibilities: normalized.responsibilities,
      modelAlias: normalized.modelAlias,
      agentHarness: normalized.agentHarness,
    });
    const replay = await this.repository.findReplay({
      appId: normalized.appId,
      idempotencyKey: normalized.idempotencyKey,
      requestHash,
    });
    if (replay) return replay;
    const model = resolveModelSelectionForWorkload(
      normalized.modelAlias,
      'chat',
    );
    if (!model.ok) {
      throw new ApplicationError('INVALID_REQUEST', model.message);
    }
    const route = resolveExecutionRoute({
      entry: model.entry,
      agentHarness: normalized.agentHarness,
    });
    if (!route.ok) {
      throw new ApplicationError('INVALID_REQUEST', route.message);
    }
    const validation = await this.validateModel({
      appId: normalized.appId,
      modelAlias: normalized.modelAlias,
      providerId: model.entry.modelRoute.id,
    });
    if (!validation.ok) {
      throw new ApplicationError('INVALID_REQUEST', validation.message);
    }
    return this.repository.createOrResume({
      ...normalized,
      requestHash,
      responseFamily: model.entry.responseFamily,
    });
  }

  async updateProgress(input: {
    appId: CreateOnboardingSetupRequestDto['appId'];
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
