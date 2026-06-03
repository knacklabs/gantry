import {
  buildControlPlaneReadModelFromSettings,
  type ControlPlaneReadModel,
} from '../../application/control-plane/control-plane-read-model.js';
import {
  controlPlaneJobStatus,
  controlPlaneMemoryStatus,
  controlPlaneProviderInputs,
} from '../../application/control-plane/control-plane-settings-inputs.js';
import { requiredModelCredentialProviders } from '../../application/model-resolution/required-model-credential-providers.js';
import type { AppId } from '../../domain/app/app.js';
import type { ControlRouteContext } from './handler-context.js';

/**
 * Build the unified control-plane read model for an authorized control request.
 * Shared by the status route and the guided-action routes so the read model
 * (and therefore the derived next action) is identical across them.
 */
export async function buildControlPlaneReadModelForRequest(
  ctx: ControlRouteContext,
  appId: AppId,
): Promise<ControlPlaneReadModel> {
  const settings = ctx.getInternalRuntimeSettings();
  const requiredProviders = requiredModelCredentialProviders(settings);
  const activeProviderIds = new Set(
    await ctx.getActiveModelCredentialProviderIds(appId),
  );
  return buildControlPlaneReadModelFromSettings({
    settings,
    workspaceKey: appId,
    modelCredentialReady: requiredProviders.every((providerId) =>
      activeProviderIds.has(providerId),
    ),
    providers: controlPlaneProviderInputs(settings),
    accessNeedsApprovalCount: await ctx.countPendingAccessRequests(appId),
    memoryStatus: controlPlaneMemoryStatus(settings.memory?.enabled === true),
    jobs: (await ctx.listControlPlaneJobs(appId)).map((job) => ({
      id: job.id,
      ...(job.workspace_key ? { agentId: job.workspace_key } : {}),
      status: controlPlaneJobStatus(job.status),
    })),
  });
}
