import type { DoctorCheck } from './doctor.js';
interface RunnerSandboxSettings {
    runtime: {
        sandbox: {
            provider: 'direct' | 'sandbox_runtime';
        };
    };
}
export declare function inspectRunnerSandbox(settings: RunnerSandboxSettings | undefined): DoctorCheck | undefined;
export {};
