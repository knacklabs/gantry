export function createInlineToolSuccessLedger() {
    const successfulTools = new Set();
    return {
        recordSuccess: (toolName) => successfulTools.add(toolName),
        hasSuccess: (toolName) => successfulTools.has(toolName),
    };
}
