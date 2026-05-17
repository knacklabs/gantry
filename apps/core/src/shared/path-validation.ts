import path from 'node:path';

export function isAbsoluteFilePath(value: string): boolean {
  return path.isAbsolute(value);
}
