import * as p from '@clack/prompts';

import { buildControlPlaneReadModelFromSettings } from '../application/control-plane/control-plane-read-model.js';
import { buildControlPlaneReadModelFromRepositories } from '../application/control-plane/control-plane-storage-model.js';
import type { ControlPlaneStorageSettings } from '../application/control-plane/control-plane-storage-model.js';
import {
  controlPlaneMemoryStatus,
  controlPlaneProviderInputs,
} from '../application/control-plane/control-plane-settings-inputs.js';
import {
  resolveControlPlaneGuidedAction,
  type GuidedActionRef,
} from '../application/guided-actions/guided-action-model.js';
import {
  formatGuidedActionPreview,
  formatGuidedActionResult,
  GuidedActionService,
  type GuidedActionExecutorMap,
  type GuidedActionResult,
} from '../application/guided-actions/guided-action-service.js';
import type { AppId } from '../domain/app/app.js';
import { isStorageUnavailableError } from '../adapters/storage/postgres/runtime-store.js';
import { runDoctorWithNetwork } from './doctor.js';

type RuntimeSettingsInput = ControlPlaneStorageSettings;
type RestartRuntime = () => { ok: boolean; message: string };

function buildExecutors(
  importMetaUrl: string,
  runtimeHome: string,
  restartRuntime: RestartRuntime,
): GuidedActionExecutorMap {
  return {
    run_verification: async (): Promise<GuidedActionResult> => {
      const report = await runDoctorWithNetwork(importMetaUrl, runtimeHome);
      const failing = report.checks.find((check) => check.status === 'fail');
      if (failing) {
        return {
          status: 'done',
          changed: 'Ran diagnostics.',
          savedTo: 'none',
          restartRequired: false,
          nextAction: failing.nextAction ?? 'Review gantry doctor output.',
        };
      }
      return {
        status: 'done',
        changed: 'Ran diagnostics. No blocking failures.',
        savedTo: 'none',
        restartRequired: false,
        nextAction: 'none',
      };
    },
    resume_job: async (ref) => {
      const jobId = ref.params?.jobId;
      if (!jobId) return { status: 'manual', instruction: ref.label };
      try {
        const { controlApiRequest } = await import('./control-api.js');
        const response = (await controlApiRequest(runtimeHome, {
          method: 'POST',
          path: `/v1/jobs/${encodeURIComponent(jobId)}/resume`,
        })) as {
          resumed?: boolean;
          setup?: {
            state?: string;
            nextAction?: string;
            blockers?: Array<{ nextAction?: string }>;
          };
        };
        return response.resumed
          ? {
              status: 'done',
              changed: `Resumed job ${jobId}.`,
              savedTo: 'runtime state',
              restartRequired: false,
              nextAction: 'none',
            }
          : {
              status: 'done',
              changed: `Job ${jobId} still needs setup.`,
              savedTo: 'runtime state',
              restartRequired: false,
              nextAction:
                response.setup?.nextAction ?? 'Resolve job setup blockers.',
            };
      } catch (err) {
        return {
          status: 'failed',
          cause: err instanceof Error ? err.message : String(err),
          recover: ref.label,
        };
      }
    },
    restart_runtime: (): GuidedActionResult => {
      const outcome = restartRuntime();
      if (!outcome.ok) {
        return {
          status: 'failed',
          cause: outcome.message,
          recover: 'Run gantry status to check the runtime, then retry.',
        };
      }
      return {
        status: 'done',
        changed: outcome.message,
        savedTo: 'none',
        restartRequired: false,
        nextAction: 'none',
      };
    },
  };
}

async function resolveCurrentGuidedAction(
  runtimeHome: string,
  settings: RuntimeSettingsInput,
): Promise<GuidedActionRef> {
  process.env.GANTRY_HOME = runtimeHome;
  const appId = 'default' as AppId;
  try {
    const { createStorageRuntime } =
      await import('../adapters/storage/postgres/factory.js');
    const storage = createStorageRuntime();
    try {
      const model = await buildControlPlaneReadModelFromRepositories({
        appId,
        settings,
        jobsRepository: storage.ops,
        modelCredentialsRepository: storage.repositories.modelCredentials,
        pendingAccessRequestsRepository:
          storage.repositories.pendingAccessRequests,
      });
      return resolveControlPlaneGuidedAction(model.nextAction);
    } finally {
      await storage.runtimeEventNotifier.close().catch(() => undefined);
      await storage.service.close().catch(() => undefined);
    }
  } catch (err) {
    if (!isStorageUnavailableError(err)) {
      p.log.warn(
        `Storage degraded: ${err instanceof Error ? err.message : String(err)}. Next action may be incomplete.`,
      );
    }
    // Graceful degradation: storage may be unreachable when running offline.
    // Fall back to a settings-only model with no jobs so `gantry next` still
    // surfaces the same next action the other surfaces would derive.
    const model = buildControlPlaneReadModelFromSettings({
      settings,
      workspaceKey: appId,
      modelCredentialReady: false,
      providers: controlPlaneProviderInputs(settings),
      memoryStatus: controlPlaneMemoryStatus(settings.memory?.enabled === true),
      jobs: [],
    });
    return resolveControlPlaneGuidedAction(model.nextAction);
  }
}

export async function runNextCommand(
  importMetaUrl: string,
  runtimeHome: string,
  args: string[],
  settings: RuntimeSettingsInput,
  restartRuntime: RestartRuntime,
): Promise<number> {
  const ref = await resolveCurrentGuidedAction(runtimeHome, settings);
  if (ref.type === 'none') {
    p.log.info('No next action. Everything looks ready.');
    return 0;
  }

  const service = new GuidedActionService(
    buildExecutors(importMetaUrl, runtimeHome, restartRuntime),
  );

  const run = args.includes('--run');
  if (!run) {
    p.note(formatGuidedActionPreview(service.preview(ref)), 'Next action');
    return 0;
  }

  const preview = service.preview(ref);
  if (preview.requiresApproval) {
    const proceed = await p.confirm({ message: 'Proceed?' });
    if (p.isCancel(proceed) || !proceed) {
      p.outro('Cancelled.');
      return 0;
    }
  }

  const result = await service.execute(ref);
  const text = formatGuidedActionResult(result);
  if (result.status === 'failed') {
    p.log.error(text);
    return 1;
  }
  if (result.status === 'manual') {
    // A manual action did not execute — surface the command, do not claim success.
    p.log.warn(text);
    return 0;
  }
  p.log.success(text);
  return 0;
}
