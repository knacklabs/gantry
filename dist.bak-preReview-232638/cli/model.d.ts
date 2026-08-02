import { type ModelProviderPreflightResult } from '../adapters/llm/model-provider-preflight.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';
type ModelCommandSettings = ReturnType<typeof ensureRuntimeSettings>;
interface ModelCommandOptions {
    preflightProvider?: (runtimeHome: string, providerId: string, settings: ModelCommandSettings, chatAlias?: string) => Promise<ModelProviderPreflightResult>;
}
export declare function runModelCommand(runtimeHome: string, args: string[], options?: ModelCommandOptions): Promise<number>;
export {};
