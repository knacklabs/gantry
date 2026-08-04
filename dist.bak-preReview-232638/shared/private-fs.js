import fs from 'fs';
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const OWNER_READONLY_FILE_MODE = 0o400;
export function ensurePrivateDirSync(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
    const stat = fs.lstatSync(dirPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Expected private directory at ${dirPath}`);
    }
    fs.chmodSync(dirPath, PRIVATE_DIR_MODE);
}
export function assertPrivateFileTargetSync(filePath) {
    try {
        if (fs.lstatSync(filePath).isSymbolicLink()) {
            throw new Error(`Refusing to write private file through symlink ${filePath}`);
        }
    }
    catch (err) {
        if (!err ||
            typeof err !== 'object' ||
            err.code !== 'ENOENT') {
            throw err;
        }
    }
}
export function writePrivateFileSync(filePath, data, options = {}) {
    assertPrivateFileTargetSync(filePath);
    fs.writeFileSync(filePath, data, {
        mode: PRIVATE_FILE_MODE,
        ...(options.flag ? { flag: options.flag } : {}),
    });
    fs.chmodSync(filePath, PRIVATE_FILE_MODE);
}
export function protectOwnerReadonlyFileSync(filePath) {
    fs.chmodSync(filePath, OWNER_READONLY_FILE_MODE);
}
