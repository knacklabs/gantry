export type ServiceKind = 'launchd' | 'systemd-user' | 'nohup' | 'background';
export interface ServiceOutcome {
    ok: boolean;
    kind: ServiceKind;
    message: string;
}
export declare function installService(importMetaUrl: string, runtimeHome: string): ServiceOutcome;
export declare function startService(runtimeHome: string): ServiceOutcome;
export declare function stopService(runtimeHome: string): ServiceOutcome;
export declare function getServiceStatus(runtimeHome: string): {
    kind: ServiceKind;
    status: string;
};
