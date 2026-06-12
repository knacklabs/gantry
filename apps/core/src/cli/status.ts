import '../channels/register-builtins.js';
import { listConnectableChannelProviders } from '../channels/provider-registry.js';

import { readEnvFile } from '../config/env/file.js';
import { DoctorReport, runDoctorWithNetwork } from './doctor.js';
import { getServiceStatus } from '../infrastructure/service/manager.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';
import { inspectMemoryHealth } from './memory-health.js';
import { isStorageUnavailableError } from '../adapters/storage/postgres/runtime-store.js';
import {
  buildControlPlaneReadModelFromSettings,
  formatControlPlaneStatus,
  type ControlPlaneReadModel,
  type ControlPlaneMemoryStatus,
} from '../application/control-plane/control-plane-read-model.js';
import { buildControlPlaneReadModelFromRepositories } from '../application/control-plane/control-plane-storage-model.js';
import { resolveProcessRole } from '../app/bootstrap/roles/role-resolver.js';
import { roleCapabilities } from '../app/bootstrap/roles/role-capabilities.js';
import type { ProcessRole } from '../app/bootstrap/roles/process-role.js';
import type { AppId } from '../domain/app/app.js';

export interface RuntimeStatusSummary {
  doctor: DoctorReport;
  service: {
    kind: string;
    status: string;
  };
  channels: Array<{
    id: string;
    label: string;
    enabled: boolean;
    missingEnvKeys: string[];
  }>;
  accessNeedsApprovalCount: number;
  modelCredentialReady: boolean;
  memoryStatus: ControlPlaneMemoryStatus;
  settings: ReturnType<typeof ensureRuntimeSettings>;
  readModel?: ControlPlaneReadModel;
  processRole: ProcessRole;
}

export async function collectRuntimeStatus(
  importMetaUrl: string,
  runtimeHome: string,
): Promise<RuntimeStatusSummary> {
  const env = readEnvFile(envFilePath(runtimeHome));
  const settings = ensureRuntimeSettings(runtimeHome);
  const service = getServiceStatus(runtimeHome);
  const doctor = await runDoctorWithNetwork(importMetaUrl, runtimeHome, {
    validateTelegramToken: false,
  });
  const memoryHealth = inspectMemoryHealth(runtimeHome, settings, env);
  const accessNeedsApprovalCount = storageUnavailable(doctor)
    ? 0
    : await countPendingAccessApprovals(runtimeHome);
  const brokerCheck = doctor.checks.find(
    (check) => check.id === 'claude-broker',
  );
  const connectedProviderIds = new Set(
    Object.values(settings.providerConnections).map(
      (connection) => connection.provider,
    ),
  );

  const channels = listConnectableChannelProviders()
    .filter(
      (provider) =>
        settings.providers[provider.id]?.enabled === true ||
        connectedProviderIds.has(provider.id),
    )
    .map((provider) => {
      const missingEnvKeys: string[] = [];
      for (const envKey of provider.setup.envKeys) {
        if (!env[envKey]?.trim()) {
          missingEnvKeys.push(envKey);
        }
      }

      return {
        id: provider.id,
        label: provider.label,
        enabled: settings.providers[provider.id]?.enabled ?? false,
        missingEnvKeys,
      };
    });

  return {
    doctor,
    service,
    channels,
    accessNeedsApprovalCount,
    modelCredentialReady: brokerCheck?.status === 'pass',
    memoryStatus: toControlPlaneMemoryStatus(
      memoryHealth.memoryEnabled,
      memoryHealth.memoryCheck.status,
    ),
    settings,
    processRole: resolveProcessRole(process.env),
    ...(!storageUnavailable(doctor)
      ? {
          readModel: await readControlPlaneModelFromStorage(
            runtimeHome,
            settings,
          ),
        }
      : {}),
  };
}

function storageUnavailable(doctor: DoctorReport): boolean {
  return doctor.checks.some(
    (check) =>
      (check.id === 'runtime-storage' || check.id === 'storage-capabilities') &&
      check.status === 'fail',
  );
}

async function countPendingAccessApprovals(
  runtimeHome: string,
): Promise<number> {
  process.env.GANTRY_HOME = runtimeHome;
  try {
    const { createStorageRuntime } =
      await import('../adapters/storage/postgres/factory.js');
    const storage = createStorageRuntime();
    try {
      return await storage.repositories.pendingAccessRequests.countPendingAccessRequests(
        { appId: 'default' as AppId },
      );
    } finally {
      await storage.runtimeEventNotifier.close().catch(() => undefined);
      await storage.service.close().catch(() => undefined);
    }
  } catch (err) {
    if (!isStorageUnavailableError(err)) {
      console.warn(
        `Storage degraded: ${err instanceof Error ? err.message : String(err)}. Pending access approvals may be undercounted.`,
      );
    }
    return 0;
  }
}

async function readControlPlaneModelFromStorage(
  runtimeHome: string,
  settings: ReturnType<typeof ensureRuntimeSettings>,
): Promise<ControlPlaneReadModel | undefined> {
  process.env.GANTRY_HOME = runtimeHome;
  try {
    const { createStorageRuntime } =
      await import('../adapters/storage/postgres/factory.js');
    const storage = createStorageRuntime();
    try {
      return await buildControlPlaneReadModelFromRepositories({
        appId: 'default' as AppId,
        settings,
        jobsRepository: storage.ops,
        jobControlRepository: storage.control,
        modelCredentialsRepository: storage.repositories.modelCredentials,
        pendingAccessRequestsRepository:
          storage.repositories.pendingAccessRequests,
      });
    } finally {
      await storage.runtimeEventNotifier.close().catch(() => undefined);
      await storage.service.close().catch(() => undefined);
    }
  } catch (err) {
    if (!isStorageUnavailableError(err)) {
      console.warn(
        `Storage degraded: ${err instanceof Error ? err.message : String(err)}. Jobs and access may be undercounted.`,
      );
    }
    return undefined;
  }
}

export function formatRuntimeStatus(summary: RuntimeStatusSummary): string {
  const withSandbox = (output: string) =>
    insertRoleStatus(
      insertSandboxStatus(output, formatSandboxStatus(summary)),
      formatRoleStatus(summary),
    );
  if (summary.readModel) {
    return withSandbox(
      formatControlPlaneStatus(summary.readModel, summary.service),
    );
  }
  return withSandbox(
    formatControlPlaneStatus(
      buildControlPlaneReadModelFromSettings({
        settings: summary.settings,
        workspaceKey: 'default',
        runtimeBlocked:
          !summary.doctor.ok && summary.doctor.blockingFailures > 0,
        modelCredentialReady: summary.modelCredentialReady,
        providers: summary.channels.map((channel) => ({
          id: channel.id,
          label: channel.label,
          ready: channel.enabled && channel.missingEnvKeys.length === 0,
        })),
        accessNeedsApprovalCount: summary.accessNeedsApprovalCount,
        memoryStatus: summary.memoryStatus,
      }),
      summary.service,
    ),
  );
}

function formatSandboxStatus(summary: RuntimeStatusSummary): string {
  const provider = summary.settings.runtime.sandbox.provider;
  if (provider === 'direct') return 'direct (compatibility, no OS sandbox)';
  const sandboxCheck = summary.doctor.checks.find(
    (check) => check.id === 'runner-sandbox',
  );
  if (sandboxCheck?.status === 'fail') {
    return `sandbox_runtime (unavailable: ${sandboxCheck.message})`;
  }
  return 'sandbox_runtime (enforcing)';
}

function insertSandboxStatus(output: string, sandboxStatus: string): string {
  const lines = output.split('\n');
  const serviceIndex = lines.findIndex((line) => line.startsWith('Service '));
  const runtimeIndex = lines.findIndex((line) => line.startsWith('Runtime:'));
  const insertAt =
    serviceIndex !== -1
      ? serviceIndex + 1
      : runtimeIndex !== -1
        ? runtimeIndex + 1
        : 1;
  lines.splice(insertAt, 0, `Sandbox: ${sandboxStatus}`);
  return lines.join('\n');
}

/**
 * One-line role + role-capability summary. The `all` workstation default lists
 * "everything"; worker roles list only what they run, so the operator can tell
 * at a glance which subsystems this process owns. Local-only (no network call).
 */
function formatRoleStatus(summary: RuntimeStatusSummary): string {
  const caps = roleCapabilities(summary.processRole);
  const enabled = [
    caps.controlApi === 'full' ? 'control:full' : 'control:ops',
    caps.liveExecution ? 'live' : null,
    caps.jobExecution ? 'jobs' : null,
    caps.providerInbound ? 'inbound' : null,
    caps.bakeExecution ? 'bake' : null,
  ].filter((value): value is string => value !== null);
  return `${summary.processRole} (${enabled.join(', ')})`;
}

function insertRoleStatus(output: string, roleStatus: string): string {
  const lines = output.split('\n');
  const sandboxIndex = lines.findIndex((line) => line.startsWith('Sandbox:'));
  const insertAt = sandboxIndex !== -1 ? sandboxIndex + 1 : 1;
  lines.splice(insertAt, 0, `Role: ${roleStatus}`);
  return lines.join('\n');
}

function toControlPlaneMemoryStatus(
  enabled: boolean,
  health: string,
): ControlPlaneMemoryStatus {
  if (!enabled) return 'Disabled';
  if (health === 'pass') return 'Ready';
  return 'Needs setup';
}
