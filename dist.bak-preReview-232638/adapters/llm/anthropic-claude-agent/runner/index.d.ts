/**
 * Gantry Agent Runner
 * Runs as the child agent process, receives config via stdin, outputs result to stdout.
 *
 * Input protocol:
 *   Stdin: Full agent input JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to GANTRY_IPC_INPUT_DIR
 *          Files: {type:"message", text:"..."}.json, polled and consumed
 *          Sentinel: GANTRY_IPC_INPUT_DIR/_close signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted. Final marker after loop ends signals completion.
 */
export {};
