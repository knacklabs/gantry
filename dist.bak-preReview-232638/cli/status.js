import '../channels/register-builtins.js';
import { listConnectableChannelProviders } from '../channels/provider-registry.js';
import { readEnvFile } from '../config/env/file.js';
import { runDoctorWithNetwork } from './doctor.js';
import { getServiceStatus } from '../infrastructure/service/manager.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';
import { runtimeSecretKeyForEnv } from '../domain/provider/provider-runtime-secret-keys.js';
import { collectUnresolvedRuntimeSecretProviderIds, isMissingRuntimeCredential, } from './runtime-secret-status.js';
import { inspectMemoryHealth } from './memory-health.js';
import { isStorageUnavailableError } from '../adapters/storage/postgres/runtime-store.js';
import { buildControlPlaneReadModelFromSettings, formatControlPlaneStatus, } from '../application/control-plane/control-plane-read-model.js';
import { buildControlPlaneReadModelFromRepositories } from '../application/control-plane/control-plane-storage-model.js';
import { createDefaultRunnerSandboxProvider } from '../adapters/llm/default-runtime-adapters.js';
import { resolveProcessRole } from '../app/bootstrap/roles/role-resolver.js';
import { roleCapabilities } from '../app/bootstrap/roles/role-capabilities.js';
import { PROCESS_ROLES, } from '../app/bootstrap/roles/process-role.js';
import { computeHostCapacityPlan, detectHostCpuThreads, HOST_EXECUTION_SLOT_KEY_PREFIX, hostExecutionSlotKey, } from '../shared/host-capacity.js';
const ASYNC_TASK_STATUS_CAPACITY = 4;
export async function collectRuntimeStatus(importMetaUrl, runtimeHome) {
    const env = readEnvFile(envFilePath(runtimeHome));
    const settings = ensureRuntimeSettings(runtimeHome);
    const service = getServiceStatus(runtimeHome);
    const doctor = await runDoctorWithNetwork(importMetaUrl, runtimeHome, {
        validateTelegramToken: false,
        validateSlackToken: false,
        validateModelCredentials: false,
    });
    const memoryHealth = inspectMemoryHealth(runtimeHome, settings, env);
    const accessNeedsApprovalCount = storageUnavailable(doctor)
        ? 0
        : await countPendingAccessApprovals(runtimeHome);
    const brokerCheck = doctor.checks.find((check) => check.id === 'claude-broker');
    const connectedProviderIds = new Set(Object.values(settings.providerAccounts).map((connection) => connection.provider));
    const unresolvedRuntimeSecretProviderIds = await collectUnresolvedRuntimeSecretProviderIds(runtimeHome, settings);
    const channels = listConnectableChannelProviders()
        .filter((provider) => settings.providers[provider.id]?.enabled === true ||
        connectedProviderIds.has(provider.id))
        .map((provider) => {
        const missingCredentialKeys = [];
        const accounts = Object.values(settings.providerAccounts).filter((account) => account.provider === provider.id);
        for (const envKey of provider.setup.envKeys) {
            const refKey = runtimeSecretKeyForEnv(provider.id, envKey);
            const credentialReady = accounts.length > 0
                ? accounts.some((account) => !isMissingRuntimeCredential({
                    providerId: provider.id,
                    envKey,
                    rawRef: account.runtimeSecretRefs[refKey],
                    env,
                    unresolvedRuntimeSecretProviderIds,
                }))
                : !isMissingRuntimeCredential({
                    providerId: provider.id,
                    envKey,
                    env,
                    unresolvedRuntimeSecretProviderIds,
                });
            if (!credentialReady) {
                missingCredentialKeys.push(envKey);
            }
        }
        return {
            id: provider.id,
            label: provider.label,
            enabled: settings.providers[provider.id]?.enabled ?? false,
            missingCredentialKeys,
        };
    });
    return {
        doctor,
        service,
        channels,
        accessNeedsApprovalCount,
        modelCredentialReady: brokerCheck?.status === 'pass',
        memoryStatus: toControlPlaneMemoryStatus(memoryHealth.memoryEnabled, memoryHealth.memoryCheck.status),
        settings,
        processRole: resolveProcessRole(process.env),
        sandboxWarmTemplate: collectSandboxWarmTemplate(settings),
        ...(!storageUnavailable(doctor)
            ? {
                runtimeCapacity: await readRuntimeCapacityFromStorage(runtimeHome, settings),
                readModel: await readControlPlaneModelFromStorage(runtimeHome, settings),
            }
            : {}),
    };
}
function collectSandboxWarmTemplate(settings) {
    return (createDefaultRunnerSandboxProvider(settings.runtime.sandbox).warmTemplate?.() ?? {
        available: false,
        cacheHit: false,
        authorityFree: true,
    });
}
function storageUnavailable(doctor) {
    return doctor.checks.some((check) => (check.id === 'runtime-storage' || check.id === 'storage-capabilities') &&
        check.status === 'fail');
}
async function countPendingAccessApprovals(runtimeHome) {
    process.env.GANTRY_HOME = runtimeHome;
    try {
        const { createStorageRuntime } = await import('../adapters/storage/postgres/factory.js');
        const storage = createStorageRuntime();
        try {
            return await storage.repositories.pendingAccessRequests.countPendingAccessRequests({ appId: 'default' });
        }
        finally {
            await storage.runtimeEventNotifier.close().catch(() => undefined);
            await storage.service.close().catch(() => undefined);
        }
    }
    catch (err) {
        if (!isStorageUnavailableError(err)) {
            console.warn(`Storage degraded: ${err instanceof Error ? err.message : String(err)}. Pending access approvals may be undercounted.`);
        }
        return 0;
    }
}
async function readControlPlaneModelFromStorage(runtimeHome, settings) {
    process.env.GANTRY_HOME = runtimeHome;
    try {
        const { createStorageRuntime } = await import('../adapters/storage/postgres/factory.js');
        const storage = createStorageRuntime();
        try {
            return await buildControlPlaneReadModelFromRepositories({
                appId: 'default',
                settings,
                jobsRepository: storage.ops,
                jobControlRepository: storage.control,
                modelCredentialsRepository: storage.repositories.modelCredentials,
                pendingAccessRequestsRepository: storage.repositories.pendingAccessRequests,
            });
        }
        finally {
            await storage.runtimeEventNotifier.close().catch(() => undefined);
            await storage.service.close().catch(() => undefined);
        }
    }
    catch (err) {
        if (!isStorageUnavailableError(err)) {
            console.warn(`Storage degraded: ${err instanceof Error ? err.message : String(err)}. Jobs and access may be undercounted.`);
        }
        return undefined;
    }
}
async function readRuntimeCapacityFromStorage(runtimeHome, settings) {
    process.env.GANTRY_HOME = runtimeHome;
    try {
        const { createStorageRuntime } = await import('../adapters/storage/postgres/factory.js');
        const storage = createStorageRuntime();
        try {
            const hostUsage = hostSlotUsageFilter();
            const interactiveUsage = hostSlotUsageFilter('interactive');
            const backgroundUsage = hostSlotUsageFilter('background');
            const [workerCounts, liveBacklog, hostInteractiveUsed, hostBackgroundUsed, hostUsed,] = await Promise.all([
                storage.service.pool.query(`SELECT process_role, count(*)::int AS count
           FROM worker_instances
           WHERE heartbeat_at > now() - interval '60 seconds'
             AND status IN ('starting', 'healthy')
           GROUP BY process_role`),
                storage.service.pool.query(`SELECT
             count(*)::int AS count,
             coalesce(max(extract(epoch FROM (now() - created_at))), 0)::int
               AS oldest_age_seconds
           FROM live_admission_work_items
           WHERE state = 'queued'
              OR (
                state = 'deferred'
                AND (defer_until IS NULL OR defer_until <= now())
              )`),
                storage.service.pool.query(`SELECT count(*)::int AS count
           FROM run_slots
           WHERE ${interactiveUsage.whereSql} AND expires_at > now()`, interactiveUsage.params),
                storage.service.pool.query(`SELECT count(*)::int AS count
           FROM run_slots
           WHERE ${backgroundUsage.whereSql} AND expires_at > now()`, backgroundUsage.params),
                storage.service.pool.query(`SELECT count(*)::int AS count
           FROM run_slots
           WHERE ${hostUsage.whereSql} AND expires_at > now()`, hostUsage.params),
            ]);
            const activeAsyncTasks = await readActiveAsyncTaskCount(storage.service.pool);
            const liveSlotsUsed = hostInteractiveUsed.rows[0]?.count ?? 0;
            const backgroundSlotsUsed = hostBackgroundUsed.rows[0]?.count ?? 0;
            const hostCapacity = resolveStatusHostCapacity({
                settings,
                workerCounts: workerCounts.rows,
            });
            const effectiveLiveCapacity = hostCapacity.liveWorkerCount > 0 ? hostCapacity.interactiveCapacity : 0;
            return {
                interactive: {
                    used: liveSlotsUsed,
                    capacity: effectiveLiveCapacity,
                    backlog: liveBacklog.rows[0]?.count ?? 0,
                    oldestBacklogSeconds: liveBacklog.rows[0]?.oldest_age_seconds ?? 0,
                    warmSpare: effectiveLiveCapacity > liveSlotsUsed ? 'available' : 'missing',
                },
                backgroundJobs: {
                    used: backgroundSlotsUsed,
                    capacity: hostCapacity.backgroundCapacity,
                },
                asyncTasks: {
                    used: activeAsyncTasks,
                    capacity: ASYNC_TASK_STATUS_CAPACITY,
                },
                host: {
                    used: hostUsed.rows[0]?.count ?? 0,
                    budget: hostCapacity.budget,
                    cpuThreads: hostCapacity.cpuThreads,
                },
            };
        }
        finally {
            await storage.runtimeEventNotifier.close().catch(() => undefined);
            await storage.service.close().catch(() => undefined);
        }
    }
    catch (err) {
        if (!isStorageUnavailableError(err)) {
            console.warn(`Storage degraded: ${err instanceof Error ? err.message : String(err)}. Runtime capacity may be unavailable.`);
        }
        return undefined;
    }
}
async function readActiveAsyncTaskCount(pool) {
    const table = await pool.query(`SELECT to_regclass('agent_async_tasks') IS NOT NULL AS exists`);
    if (!table.rows[0]?.exists)
        return 0;
    const active = await pool.query(`SELECT count(*)::int AS count
     FROM agent_async_tasks
     WHERE status IN ('queued', 'running', 'needs_attention')`);
    return active.rows[0]?.count ?? 0;
}
function hostSlotUsageFilter(runtimeClass) {
    if (process.env.GANTRY_HOST_ID?.trim()) {
        return {
            whereSql: 'slot_key = $1',
            params: [hostExecutionSlotKey(undefined, runtimeClass)],
        };
    }
    if (runtimeClass) {
        return {
            whereSql: 'slot_key LIKE $1',
            params: [`${HOST_EXECUTION_SLOT_KEY_PREFIX}%:${runtimeClass}`],
        };
    }
    return {
        whereSql: 'slot_key LIKE $1 AND slot_key NOT LIKE $2 AND slot_key NOT LIKE $3',
        params: [
            `${HOST_EXECUTION_SLOT_KEY_PREFIX}%`,
            `${HOST_EXECUTION_SLOT_KEY_PREFIX}%:interactive`,
            `${HOST_EXECUTION_SLOT_KEY_PREFIX}%:background`,
        ],
    };
}
function resolveStatusHostCapacity(input) {
    const cpuThreads = detectHostCpuThreads();
    if (process.env.GANTRY_HOST_ID?.trim()) {
        const allPlan = computeHostCapacityPlan({
            queue: input.settings.runtime.queue,
            processRole: 'all',
            cpuThreads,
        });
        const livePlan = computeHostCapacityPlan({
            queue: input.settings.runtime.queue,
            processRole: 'live-worker',
            cpuThreads,
        });
        const jobPlan = computeHostCapacityPlan({
            queue: input.settings.runtime.queue,
            processRole: 'job-worker',
            cpuThreads,
        });
        const allCount = sumRoleCounts(input.workerCounts, ['all']);
        const liveWorkerCount = sumRoleCounts(input.workerCounts, [
            'all',
            'live-worker',
        ]);
        const jobWorkerCount = sumRoleCounts(input.workerCounts, [
            'all',
            'job-worker',
        ]);
        return {
            interactiveCapacity: allCount > 0
                ? allPlan.interactiveCapacity
                : liveWorkerCount > 0
                    ? livePlan.interactiveCapacity
                    : 0,
            backgroundCapacity: allCount > 0
                ? allPlan.backgroundCapacity
                : jobWorkerCount > 0
                    ? jobPlan.backgroundCapacity
                    : 0,
            budget: liveWorkerCount > 0 || jobWorkerCount > 0 ? cpuThreads : 0,
            cpuThreads,
            liveWorkerCount,
        };
    }
    let interactiveCapacity = 0;
    let backgroundCapacity = 0;
    let budget = 0;
    let liveWorkerCount = 0;
    for (const role of PROCESS_ROLES) {
        const count = sumRoleCounts(input.workerCounts, [role]);
        if (count <= 0 || role === 'control')
            continue;
        const plan = computeHostCapacityPlan({
            queue: input.settings.runtime.queue,
            processRole: role,
            cpuThreads,
        });
        interactiveCapacity += plan.interactiveCapacity * count;
        backgroundCapacity += plan.backgroundCapacity * count;
        budget += plan.budget * count;
        if (role === 'all' || role === 'live-worker')
            liveWorkerCount += count;
    }
    return {
        interactiveCapacity,
        backgroundCapacity,
        budget,
        cpuThreads,
        liveWorkerCount,
    };
}
function sumRoleCounts(rows, roles) {
    return rows
        .filter((row) => roles.includes(row.process_role))
        .reduce((sum, row) => sum + row.count, 0);
}
export function formatRuntimeStatus(summary) {
    const withSandbox = (output) => insertRoleStatus(insertSandboxTemplateStatus(insertSandboxStatus(output, formatSandboxStatus(summary)), formatSandboxWarmTemplateStatus(summary)), formatRoleStatus(summary));
    const output = summary.readModel
        ? formatControlPlaneStatus(summary.readModel, summary.service)
        : formatControlPlaneStatus(buildControlPlaneReadModelFromSettings({
            settings: summary.settings,
            workspaceKey: 'default',
            runtimeBlocked: !summary.doctor.ok && summary.doctor.blockingFailures > 0,
            modelCredentialReady: summary.modelCredentialReady,
            providers: summary.channels.map((channel) => ({
                id: channel.id,
                label: channel.label,
                ready: channel.enabled && channel.missingCredentialKeys.length === 0,
            })),
            accessNeedsApprovalCount: summary.accessNeedsApprovalCount,
            memoryStatus: summary.memoryStatus,
        }), summary.service);
    return insertRuntimeCapacityStatus(withSandbox(output), summary);
}
function formatSandboxStatus(summary) {
    const provider = summary.settings.runtime.sandbox.provider;
    if (provider === 'direct')
        return 'direct (compatibility, no OS sandbox)';
    const sandboxCheck = summary.doctor.checks.find((check) => check.id === 'runner-sandbox');
    if (sandboxCheck?.status === 'fail') {
        return `sandbox_runtime (unavailable: ${sandboxCheck.message})`;
    }
    return 'sandbox_runtime (enforcing)';
}
function insertSandboxStatus(output, sandboxStatus) {
    const lines = output.split('\n');
    const serviceIndex = lines.findIndex((line) => line.startsWith('Service '));
    const runtimeIndex = lines.findIndex((line) => line.startsWith('Runtime:'));
    const insertAt = serviceIndex !== -1
        ? serviceIndex + 1
        : runtimeIndex !== -1
            ? runtimeIndex + 1
            : 1;
    lines.splice(insertAt, 0, `Sandbox: ${sandboxStatus}`);
    return lines.join('\n');
}
function formatSandboxWarmTemplateStatus(summary) {
    const status = summary.sandboxWarmTemplate ?? {
        available: false,
        cacheHit: false,
        authorityFree: true,
    };
    return `${status.available ? 'available' : 'unavailable'}, ${status.cacheHit ? 'cache hit' : 'cache miss'}`;
}
function insertSandboxTemplateStatus(output, sandboxTemplateStatus) {
    const lines = output.split('\n');
    const sandboxIndex = lines.findIndex((line) => line.startsWith('Sandbox:'));
    const insertAt = sandboxIndex !== -1 ? sandboxIndex + 1 : 1;
    lines.splice(insertAt, 0, `Sandbox warm template: ${sandboxTemplateStatus}`);
    return lines.join('\n');
}
function insertRuntimeCapacityStatus(output, summary) {
    const capacity = summary.runtimeCapacity;
    if (!capacity)
        return output;
    const lines = output.split('\n');
    const roleIndex = lines.findIndex((line) => line.startsWith('Role:'));
    const insertAt = roleIndex !== -1 ? roleIndex + 1 : 1;
    lines.splice(insertAt, 0, `Interactive capacity: ${capacity.interactive.used}/${capacity.interactive.capacity}`, `Interactive backlog: ${capacity.interactive.backlog}, oldest ${capacity.interactive.oldestBacklogSeconds}s`, `Background jobs: ${capacity.backgroundJobs.used}/${capacity.backgroundJobs.capacity}`, `Async tasks: ${capacity.asyncTasks.used}/${capacity.asyncTasks.capacity}`, `Host capacity: ${capacity.host.used}/${capacity.host.budget}, CPU threads ${capacity.host.cpuThreads}`, `Live warm spare: ${capacity.interactive.warmSpare}`);
    return lines.join('\n');
}
/**
 * One-line role + role-capability summary. The `all` workstation default lists
 * "everything"; worker roles list only what they run, so the operator can tell
 * at a glance which subsystems this process owns. Local-only (no network call).
 */
function formatRoleStatus(summary) {
    const caps = roleCapabilities(summary.processRole);
    const enabled = [
        caps.controlApi === 'full' ? 'control:full' : 'control:ops',
        caps.liveExecution ? 'live' : null,
        caps.jobExecution ? 'jobs' : null,
        caps.providerInbound ? 'inbound' : null,
        caps.bakeExecution ? 'bake' : null,
    ].filter((value) => value !== null);
    return `${summary.processRole} (${enabled.join(', ')})`;
}
function insertRoleStatus(output, roleStatus) {
    const lines = output.split('\n');
    const sandboxTemplateIndex = lines.findIndex((line) => line.startsWith('Sandbox warm template:'));
    const sandboxIndex = lines.findIndex((line) => line.startsWith('Sandbox:'));
    const insertAt = sandboxTemplateIndex !== -1
        ? sandboxTemplateIndex + 1
        : sandboxIndex !== -1
            ? sandboxIndex + 1
            : 1;
    lines.splice(insertAt, 0, `Role: ${roleStatus}`);
    return lines.join('\n');
}
function toControlPlaneMemoryStatus(enabled, health) {
    if (!enabled)
        return 'Disabled';
    if (health === 'pass')
        return 'Ready';
    return 'Needs setup';
}
