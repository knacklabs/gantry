export const OUTPUT_START_MARKER = '---GANTRY_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---GANTRY_OUTPUT_END---';
export function writeOutput(output) {
    console.log(OUTPUT_START_MARKER);
    console.log(JSON.stringify(output));
    console.log(OUTPUT_END_MARKER);
}
