export interface LocalScratchDirectory {
    runId: string;
    baseTempDir: string;
    path: string;
    cleanup: () => void;
}
export interface RuntimeMaterialization {
    runId: string;
    baseTempDir: string;
    cleanup: () => void;
}
