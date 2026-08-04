import { type SandboxAskCallback, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
export declare const allowSandboxRuntimeDestination: SandboxAskCallback;
export declare function sandboxRuntimeAskCallback(config: Pick<SandboxRuntimeConfig, 'network'>): SandboxAskCallback | undefined;
