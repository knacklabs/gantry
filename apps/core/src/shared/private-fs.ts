import fs from 'fs';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const OWNER_READONLY_FILE_MODE = 0o400;

export function ensurePrivateDirSync(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  const stat = fs.lstatSync(dirPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Expected private directory at ${dirPath}`);
  }
  fs.chmodSync(dirPath, PRIVATE_DIR_MODE);
}

export function assertPrivateFileTargetSync(filePath: string): void {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error(
        `Refusing to write private file through symlink ${filePath}`,
      );
    }
  } catch (err) {
    if (
      !err ||
      typeof err !== 'object' ||
      (err as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      throw err;
    }
  }
}

export function writePrivateFileSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options: { flag?: string } = {},
): void {
  assertPrivateFileTargetSync(filePath);
  fs.writeFileSync(filePath, data, {
    mode: PRIVATE_FILE_MODE,
    ...(options.flag ? { flag: options.flag } : {}),
  });
  fs.chmodSync(filePath, PRIVATE_FILE_MODE);
}

export function protectOwnerReadonlyFileSync(filePath: string): void {
  fs.chmodSync(filePath, OWNER_READONLY_FILE_MODE);
}
