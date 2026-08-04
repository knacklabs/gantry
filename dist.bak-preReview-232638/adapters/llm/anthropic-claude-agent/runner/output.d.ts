import type { AgentRunnerOutput } from './types.js';
export declare const OUTPUT_START_MARKER = "---GANTRY_OUTPUT_START---";
export declare const OUTPUT_END_MARKER = "---GANTRY_OUTPUT_END---";
export declare function writeOutput(output: AgentRunnerOutput): void;
