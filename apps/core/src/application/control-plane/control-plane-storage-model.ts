import type { AppId } from '../../domain/app/app.js';
import type { ModelCredentialRepository } from '../../domain/ports/repositories.js';
import type { RuntimeJobRepository } from '../../domain/repositories/ops-repo.js';
import {
  DEFAULT_JOB_RUNTIME_APP_ID,
  filterJobsByCanonicalAppSession,
  type JobAppSessionLookupPort,
} from '../jobs/job-access.js';
import {
  requiredModelCredentialProviders,
  type RequiredModelCredentialProvidersSettings,
} from '../model-resolution/required-model-credential-providers.js';
import {
  buildControlPlaneReadModelFromSettings,
  type ControlPlaneReadModel,
  type ControlPlaneSettingsReadModelInput,
} from './control-plane-read-model.js';
import {
  controlPlaneJobStatus,
  controlPlaneMemoryStatus,
  controlPlaneProviderInputs,
  type ControlPlaneSettingsInputView,
} from './control-plane-settings-inputs.js';

export type ControlPlaneStorageSettings =
  ControlPlaneSettingsReadModelInput['settings'] &
    ControlPlaneSettingsInputView &
    RequiredModelCredentialProvidersSettings;

/**
 * Build the unified control-plane read model from runtime storage repositories.
 * Shared by the CLI (`gantry next`) and the MCP guided-action preview so both
 * derive the identical next action, including jobs, that the Control API already
 * derives via its injected request context.
 */
export async function buildControlPlaneReadModelFromRepositories(input: {
  appId: AppId;
  settings: ControlPlaneStorageSettings;
  jobsRepository: Pick<RuntimeJobRepository, 'listJobs'>;
  jobControlRepository?: JobAppSessionLookupPort;
  modelCredentialsRepository: Pick<
    ModelCredentialRepository,
    'listModelCredentials'
  >;
  pendingAccessRequestsRepository: {
    countPendingAccessRequests(input: { appId: AppId }): Promise<number>;
  };
}): Promise<ControlPlaneReadModel> {
  const { appId, settings } = input;
  const credentials =
    await input.modelCredentialsRepository.listModelCredentials({ appId });
  const jobs = await listControlPlaneJobs(input);
  const accessNeedsApprovalCount =
    await input.pendingAccessRequestsRepository.countPendingAccessRequests({
      appId,
    });
  const activeProviderIds = new Set<string>(
    credentials
      .filter((credential) => credential.status === 'active')
      .map((credential) => credential.providerId),
  );
  const requiredProviders = requiredModelCredentialProviders(settings);
  return buildControlPlaneReadModelFromSettings({
    settings,
    workspaceKey: appId,
    modelCredentialReady: requiredProviders.every((providerId) =>
      activeProviderIds.has(providerId),
    ),
    providers: controlPlaneProviderInputs(settings),
    accessNeedsApprovalCount,
    memoryStatus: controlPlaneMemoryStatus(settings.memory?.enabled === true),
    jobs: jobs.map((job) => ({
      id: job.id,
      ...(job.workspace_key ? { agentId: job.workspace_key } : {}),
      status: controlPlaneJobStatus(job.status),
    })),
  });
}

async function listControlPlaneJobs(input: {
  appId: AppId;
  jobsRepository: Pick<RuntimeJobRepository, 'listJobs'>;
  jobControlRepository?: JobAppSessionLookupPort;
}) {
  const defaultScope = input.appId === DEFAULT_JOB_RUNTIME_APP_ID;
  const jobs = await input.jobsRepository.listJobs({
    ...(defaultScope && input.jobControlRepository
      ? {}
      : { appId: input.appId }),
  });
  return input.jobControlRepository
    ? filterJobsByCanonicalAppSession({
        control: input.jobControlRepository,
        jobs,
        appId: input.appId,
      })
    : jobs;
}
