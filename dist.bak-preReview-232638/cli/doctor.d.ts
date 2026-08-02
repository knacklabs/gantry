import '../channels/register-builtins.js';
import type { GuidedActionRef } from '../application/guided-actions/guided-action-model.js';
export type DoctorStatus = 'pass' | 'warn' | 'fail';
export interface DoctorCheck {
    id: string;
    title: string;
    status: DoctorStatus;
    message: string;
    nextAction?: string;
    action?: GuidedActionRef;
}
export type DoctorReport = {
    ok: boolean;
    blockingFailures: number;
    warnings: number;
    checks: DoctorCheck[];
};
export type DoctorNetworkOptions = {
    validateTelegramToken?: boolean;
    validateSlackToken?: boolean;
    validateModelCredentials?: boolean;
    modelCredentialLiveSkipProviderIds?: readonly string[];
    telegramTimeoutMs?: number;
    slackTimeoutMs?: number;
};
type DoctorRuntimeSecretOptions = {
    unresolvedRuntimeSecretProviderIds?: Set<string>;
};
export declare function hasRuntimeConfig(runtimeHome: string): boolean;
export declare function hasProcessableGroupForConfiguredChannel(runtimeHome: string): Promise<boolean>;
export declare function runDoctor(importMetaUrl: string, runtimeHome: string, runtimeSecretOptions?: DoctorRuntimeSecretOptions): DoctorReport;
export declare function runDoctorWithNetwork(importMetaUrl: string, runtimeHome: string, options?: DoctorNetworkOptions): Promise<DoctorReport>;
export declare function formatDoctorReport(report: DoctorReport): string;
export {};
