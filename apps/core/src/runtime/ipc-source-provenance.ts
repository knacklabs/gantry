import { toTrimmedString } from '../shared/object.js';

export interface IpcSourceProvenance {
  sourceJobId?: string;
  sourceRunId?: string;
  sourceRunKind?: 'interactive' | 'scheduled';
}

function sourceId(value: unknown, label: string): string | undefined {
  const parsed = toTrimmedString(value, { maxLen: 128 });
  if (parsed === undefined) {
    throw new Error(`${label} must be a string up to 128 characters`);
  }
  return parsed;
}

export function readIpcSourceProvenance(
  context: Record<string, unknown> | undefined,
  label: string,
): IpcSourceProvenance {
  if (!context) return {};
  const sourceJobId = Object.hasOwn(context, 'sourceJobId')
    ? sourceId(context.sourceJobId, `${label} context.sourceJobId`)
    : undefined;
  const sourceRunId = Object.hasOwn(context, 'sourceRunId')
    ? sourceId(context.sourceRunId, `${label} context.sourceRunId`)
    : undefined;
  const sourceRunKind = Object.hasOwn(context, 'sourceRunKind')
    ? context.sourceRunKind
    : undefined;
  if (
    sourceRunKind !== undefined &&
    sourceRunKind !== 'interactive' &&
    sourceRunKind !== 'scheduled'
  ) {
    throw new Error(
      `${label} context.sourceRunKind must be interactive or scheduled`,
    );
  }
  return { sourceJobId, sourceRunId, sourceRunKind };
}
