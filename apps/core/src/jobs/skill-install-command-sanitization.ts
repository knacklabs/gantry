import { toTrimmedString } from './ipc-shared.js';

export function redactCommandOutput(value: string): string {
  return value.replace(
    /[A-Za-z0-9_=-]*(TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_=-]*/gi,
    '<redacted>',
  );
}

export function sanitizedStringList(values: unknown[]): string[] {
  return [
    ...new Set(
      values
        .slice(0, 50)
        .map((item) => toTrimmedString(item, { maxLen: 512 }))
        .filter((item): item is string => Boolean(item)),
    ),
  ];
}
