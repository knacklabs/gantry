export declare const PRIVATE_DIR_MODE = 448;
export declare const PRIVATE_FILE_MODE = 384;
export declare const OWNER_READONLY_FILE_MODE = 256;
export declare function ensurePrivateDirSync(dirPath: string): void;
export declare function assertPrivateFileTargetSync(filePath: string): void;
export declare function writePrivateFileSync(filePath: string, data: string | NodeJS.ArrayBufferView, options?: {
    flag?: string;
}): void;
export declare function protectOwnerReadonlyFileSync(filePath: string): void;
