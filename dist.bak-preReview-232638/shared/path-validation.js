import path from 'node:path';
export function isAbsoluteFilePath(value) {
    return path.isAbsolute(value);
}
