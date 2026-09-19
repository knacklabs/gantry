import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import { OnboardingAssignmentRepository } from './onboarding/onboarding-assignment-repository.postgres.js';
import { OnboardingCandidateRepository } from './onboarding/onboarding-candidate-repository.postgres.js';
import { OnboardingDeploymentRepository } from './onboarding/onboarding-deployment-repository.postgres.js';
import { OnboardingEmployeeActivationRepository } from './onboarding/onboarding-employee-activation-repository.postgres.js';
import { OnboardingVerificationRepository } from './onboarding/onboarding-verification-repository.postgres.js';

export type { OnboardingStatusProjection } from './onboarding/onboarding-deployment-repository.postgres.js';

export class PostgresOnboardingLifecycleRepository {
  private readonly deployment: OnboardingDeploymentRepository;
  private readonly assignment: OnboardingAssignmentRepository;
  private readonly candidate: OnboardingCandidateRepository;
  private readonly employeeActivation: OnboardingEmployeeActivationRepository;
  private readonly verification: OnboardingVerificationRepository;

  constructor(db: CanonicalDb) {
    this.deployment = new OnboardingDeploymentRepository(db);
    this.assignment = new OnboardingAssignmentRepository(db);
    this.candidate = new OnboardingCandidateRepository(db, this.deployment);
    this.employeeActivation = new OnboardingEmployeeActivationRepository(
      db,
      this.candidate,
      this.deployment,
    );
    this.verification = new OnboardingVerificationRepository(
      db,
      this.deployment,
    );
  }

  status(input: Parameters<OnboardingDeploymentRepository['status']>[0]) {
    return this.deployment.status(input);
  }

  ensureDeployment(
    input: Parameters<OnboardingDeploymentRepository['ensureDeployment']>[0],
  ) {
    return this.deployment.ensureDeployment(input);
  }

  operationReplay(
    input: Parameters<OnboardingDeploymentRepository['operationReplay']>[0],
  ) {
    return this.deployment.operationReplay(input);
  }

  saveOperation(
    input: Parameters<OnboardingDeploymentRepository['saveOperation']>[0],
  ) {
    return this.deployment.saveOperation(input);
  }

  recordProjectionReceipt(
    input: Parameters<
      OnboardingDeploymentRepository['recordProjectionReceipt']
    >[0],
  ) {
    return this.deployment.recordProjectionReceipt(input);
  }

  recordSlackWorkAssignment(
    input: Parameters<
      OnboardingDeploymentRepository['recordSlackWorkAssignment']
    >[0],
  ) {
    return this.deployment.recordSlackWorkAssignment(input);
  }

  bindWorkAssignment(
    input: Parameters<OnboardingAssignmentRepository['bindWorkAssignment']>[0],
  ) {
    return this.assignment.bindWorkAssignment(input);
  }

  stageModelCredentialCandidate(
    input: Parameters<
      OnboardingCandidateRepository['stageModelCredentialCandidate']
    >[0],
  ) {
    return this.candidate.stageModelCredentialCandidate(input);
  }

  getModelCredentialCandidate(
    input: Parameters<
      OnboardingCandidateRepository['getModelCredentialCandidate']
    >[0],
  ) {
    return this.candidate.getModelCredentialCandidate(input);
  }

  transitionModelCredentialCandidate(
    input: Parameters<
      OnboardingCandidateRepository['transitionModelCredentialCandidate']
    >[0],
  ) {
    return this.candidate.transitionModelCredentialCandidate(input);
  }

  bindModelSelectionForVerification(
    input: Parameters<
      OnboardingCandidateRepository['bindModelSelectionForVerification']
    >[0],
  ) {
    return this.candidate.bindModelSelectionForVerification(input);
  }

  stageSlackWorkspaceCandidate(
    input: Parameters<
      OnboardingCandidateRepository['stageSlackWorkspaceCandidate']
    >[0],
  ) {
    return this.candidate.stageSlackWorkspaceCandidate(input);
  }

  getSlackWorkspaceCandidate(
    input: Parameters<
      OnboardingCandidateRepository['getSlackWorkspaceCandidate']
    >[0],
  ) {
    return this.candidate.getSlackWorkspaceCandidate(input);
  }

  transitionSlackWorkspaceCandidate(
    input: Parameters<
      OnboardingCandidateRepository['transitionSlackWorkspaceCandidate']
    >[0],
  ) {
    return this.candidate.transitionSlackWorkspaceCandidate(input);
  }

  recordSlackWorkspaceActivation(
    input: Parameters<
      OnboardingCandidateRepository['recordSlackWorkspaceActivation']
    >[0],
  ) {
    return this.candidate.recordSlackWorkspaceActivation(input);
  }

  activateModelAndCreateEmployee(
    input: Parameters<
      OnboardingEmployeeActivationRepository['activateModelAndCreateEmployee']
    >[0],
  ) {
    return this.employeeActivation.activateModelAndCreateEmployee(input);
  }

  createChallenge(
    input: Parameters<OnboardingVerificationRepository['createChallenge']>[0],
  ) {
    return this.verification.createChallenge(input);
  }

  currentChallenge(
    input: Parameters<OnboardingVerificationRepository['currentChallenge']>[0],
  ) {
    return this.verification.currentChallenge(input);
  }

  matchInboundChallenge(
    input: Parameters<
      OnboardingVerificationRepository['matchInboundChallenge']
    >[0],
  ) {
    return this.verification.matchInboundChallenge(input);
  }

  consumeInboundChallenge(
    input: Parameters<
      OnboardingVerificationRepository['consumeInboundChallenge']
    >[0],
  ) {
    return this.verification.consumeInboundChallenge(input);
  }
}
