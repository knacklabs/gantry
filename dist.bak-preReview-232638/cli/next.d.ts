import type { ControlPlaneStorageSettings } from '../application/control-plane/control-plane-storage-model.js';
type RuntimeSettingsInput = ControlPlaneStorageSettings;
type RestartRuntime = () => {
    ok: boolean;
    message: string;
};
export declare function runNextCommand(importMetaUrl: string, runtimeHome: string, args: string[], settings: RuntimeSettingsInput, restartRuntime: RestartRuntime): Promise<number>;
export {};
