import { toTrimmedString } from './ipc-shared.js';

export function mcpListToolsProxyInput(payload: Record<string, unknown>): {
  serverName?: string;
  query?: string;
  limit?: number;
  cursor?: string;
} {
  const serverName = toTrimmedString(payload.serverName, { maxLen: 80 });
  const query = toTrimmedString(payload.query, { maxLen: 200 });
  const cursor = toTrimmedString(payload.cursor, { maxLen: 40 });
  const limit =
    typeof payload.limit === 'number' && Number.isFinite(payload.limit)
      ? Math.trunc(payload.limit)
      : undefined;
  return {
    ...(serverName ? { serverName } : {}),
    ...(query ? { query } : {}),
    ...(typeof limit === 'number' ? { limit } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

export function mcpDescribeToolProxyInput(payload: Record<string, unknown>): {
  serverName?: string;
  toolName?: string;
} {
  const serverName = toTrimmedString(payload.serverName, { maxLen: 80 });
  const toolName = toTrimmedString(payload.toolName, { maxLen: 160 });
  return {
    ...(serverName ? { serverName } : {}),
    ...(toolName ? { toolName } : {}),
  };
}

export function mcpCallToolProxyInput(payload: Record<string, unknown>): {
  serverName?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  argumentPayload?: unknown;
  missingFields: string[];
  invalidArguments: boolean;
} {
  const serverName = toTrimmedString(payload.serverName, { maxLen: 80 });
  const toolName = toTrimmedString(payload.toolName, { maxLen: 160 });
  const argumentPayload = payload.arguments;
  const hasArgumentPayload = Object.prototype.hasOwnProperty.call(
    payload,
    'arguments',
  );
  const invalidArguments =
    hasArgumentPayload &&
    (!argumentPayload ||
      typeof argumentPayload !== 'object' ||
      Array.isArray(argumentPayload));
  return {
    ...(serverName ? { serverName } : {}),
    ...(toolName ? { toolName } : {}),
    ...(hasArgumentPayload ? { argumentPayload } : {}),
    ...(hasArgumentPayload && !invalidArguments
      ? { arguments: argumentPayload as Record<string, unknown> }
      : {}),
    missingFields: [
      ...(serverName ? [] : ['serverName']),
      ...(toolName ? [] : ['toolName']),
    ],
    invalidArguments,
  };
}
