export declare function safeRealpathSync(targetPath: string): string;
export declare function resolvePathWithRealParent(targetPath: string): string;
export declare function isPathInside(rootDir: string, candidatePath: string): boolean;
export declare function writeFileAtomic(filePath: string, content: string | Buffer, opts?: {
    mode?: number;
}): void;
