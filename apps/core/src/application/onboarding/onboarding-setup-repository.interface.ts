import type {
  CreateOnboardingSetupRequestDto,
  OnboardingProgress,
  OnboardingSetupResponseDto,
} from './onboarding-setup.dto.js';

export type CreateOnboardingSetupPersistenceInput =
  CreateOnboardingSetupRequestDto & {
    requestHash: string;
    responseFamily: string;
  };

export interface OnboardingSetupRepository {
  findReplay(input: {
    appId: CreateOnboardingSetupRequestDto['appId'];
    idempotencyKey: string;
    requestHash: string;
  }): Promise<OnboardingSetupResponseDto | null>;
  createOrResume(
    input: CreateOnboardingSetupPersistenceInput,
  ): Promise<OnboardingSetupResponseDto>;
  updateProgress(input: {
    appId: CreateOnboardingSetupRequestDto['appId'];
    setupId: string;
    actorId: string;
    progress: OnboardingProgress;
  }): Promise<void>;
}
