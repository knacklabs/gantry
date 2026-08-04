// Provider-neutral runner output frame contract shared by execution-adapter
// runners. Frames are written to stdout between OUTPUT_START_MARKER and
// OUTPUT_END_MARKER as a single JSON line; the host parses them in
// agent-spawn-process.ts (see AgentOutput in agent-spawn-types.ts). This module
// is the neutral mirror of that host type for runner authors so a new adapter
// runner does not import any provider-specific runner types.
export const OUTPUT_START_MARKER = '---GANTRY_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---GANTRY_OUTPUT_END---';
export function writeRunnerFrame(frame) {
    console.log(OUTPUT_START_MARKER);
    console.log(JSON.stringify(frame));
    console.log(OUTPUT_END_MARKER);
}
export async function readRunnerStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
            data += chunk;
        });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}
