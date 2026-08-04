import type { BrowserBackendAction } from '../../shared/browser-backend-actions.js';
export declare function ensureBrowserArtifactRoot(dir: string): string;
export declare function writeBrowserArtifactFileSync(filename: string, content: Buffer | string, encoding?: BufferEncoding, options?: {
    exclusive?: boolean;
}): void;
export declare function normalizeBrowserFilePayload(toolName: BrowserBackendAction, payload: Record<string, unknown>, options: {
    fileAccessRoot: string;
}): Record<string, unknown>;
