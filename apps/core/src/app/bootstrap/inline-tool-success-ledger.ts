export function createInlineToolSuccessLedger() {
  const successfulTools = new Set<string>();
  return {
    recordSuccess: (toolName: string) => successfulTools.add(toolName),
    hasSuccess: (toolName: string) => successfulTools.has(toolName),
  };
}
