import '../channels/register-builtins.js';
import { DoctorReport } from './doctor.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';
import { type ControlPlaneReadModel, type ControlPlaneMemoryStatus } from '../application/control-plane/control-plane-read-model.js';
import { type ProcessRole } from '../app/bootstrap/roles/process-role.js';
import type { RunnerSandboxWarmTemplateStatus } from '../shared/runner-sandbox-provider.js';
export interface RuntimeCapacityStatus {
    interactive: {
        used: number;
        capacity: number;
        backlog: number;
        oldestBacklogSeconds: number;
        warmSpare: 'available' | 'missing';
    };
    backgroundJobs: {
        used: number;
        capacity: number;
    };
    asyncTasks: {
        used: number;
        capacity: number;
    };
    host: {
        used: number;
        budget: number;
        cpuThreads: number;
    };
}
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
        missingCredentialKeys: string[];
    }>;
    accessNeedsApprovalCount: number;
    modelCredentialReady: boolean;
    memoryStatus: ControlPlaneMemoryStatus;
    settings: ReturnType<typeof ensureRuntimeSettings>;
    readModel?: ControlPlaneReadModel;
    processRole: ProcessRole;
    runtimeCapacity?: RuntimeCapacityStatus;
    sandboxWarmTemplate?: RunnerSandboxWarmTemplateStatus;
}
export declare function collectRuntimeStatus(importMetaUrl: string, runtimeHome: string): Promise<RuntimeStatusSummary>;
export declare function formatRuntimeStatus(summary: RuntimeStatusSummary): string;
