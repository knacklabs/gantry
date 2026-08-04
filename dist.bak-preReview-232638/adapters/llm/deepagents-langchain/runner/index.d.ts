/**
 * Gantry DeepAgents (LangChain) Agent Runner
 *
 * Runs as the child agent process for the `deepagents:langchain` execution
 * adapter. Receives full AgentInput JSON via stdin (read until EOF), executes a
 * tool-less DeepAgents run through Gantry's loopback model gateway, and emits
 * provider-neutral runner output frames on stdout (see runner/runner-frame.ts).
 *
 * Input protocol:
 *   Stdin: full agent input JSON (read until EOF)
 *   IPC:   live follow-up messages as JSON files under GANTRY_IPC_INPUT_DIR
 *          ({type:"message", text:"..."}.json); a `_close` sentinel ends it.
 *
 * Stdout protocol: each frame wrapped in OUTPUT_START/OUTPUT_END markers.
 */
export {};
