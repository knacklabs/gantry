import type {
  CreateOnboardingSetupRequestDto,
  OnboardingProgress,
  OnboardingSetupResponseDto,
} from './onboarding-setup.dto.js';

export interface OnboardingSetupRepository {
  createOrResume(
    input: CreateOnboardingSetupRequestDto & { requestHash: string },
  ): Promise<OnboardingSetupResponseDto>;
  updateProgress(input: {
    appId: CreateOnboardingSetupRequestDto['appId'];
    setupId: string;
    actorId: string;
    progress: OnboardingProgress;
  }): Promise<void>;
}
