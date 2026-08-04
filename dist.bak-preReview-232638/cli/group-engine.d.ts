import type { RuntimeSettings } from '../config/settings/runtime-settings-types.js';
import { type AgentHarness } from '../shared/agent-engine.js';
export declare function selectedAgentHarnessForFolder(settings: RuntimeSettings, folder: string): AgentHarness;
export declare function formatAgentHarnessCell(settings: RuntimeSettings, folder: string): string;
export declare function formatAgentHarnessLine(settings: RuntimeSettings, folder: string): string;
