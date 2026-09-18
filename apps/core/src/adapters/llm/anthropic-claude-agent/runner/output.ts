import type { AgentRunnerOutput } from './types.js';

export const OUTPUT_START_MARKER = '---GANTRY_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---GANTRY_OUTPUT_END---';

export function writeOutput(output: AgentRunnerOutput): void {
  const { newSessionId: _providerSessionHandle, ...publicOutput } = output;
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(publicOutput));
  console.log(OUTPUT_END_MARKER);
}
