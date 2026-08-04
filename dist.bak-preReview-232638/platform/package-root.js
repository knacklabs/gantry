import fs from 'fs';
import path from 'path';
export function resolvePackageRootFromSourceDir(sourceDir) {
    let currentDir = path.resolve(sourceDir);
    while (true) {
        if (fs.existsSync(path.join(currentDir, 'package.json'))) {
            return currentDir;
        }
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
            break;
        }
        currentDir = parentDir;
    }
    return process.cwd();
}
