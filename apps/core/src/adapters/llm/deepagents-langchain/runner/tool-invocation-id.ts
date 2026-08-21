export function runnableToolInvocationId(config: unknown): string | undefined {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return undefined;
  }
  const record = config as Record<string, unknown>;
  const toolCall =
    record.toolCall &&
    typeof record.toolCall === 'object' &&
    !Array.isArray(record.toolCall)
      ? (record.toolCall as Record<string, unknown>)
      : undefined;
  return (
    stringValue(toolCall?.id) ??
    stringValue(record.runId) ??
    stringValue(record.run_id)
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
