export interface GantryFacadeWorkspaceConfig {
    cwd?: string;
}
export declare function workspaceRoot(config: GantryFacadeWorkspaceConfig): Promise<string>;
export declare function resolveExistingWorkspacePath(relativePath: string, config: GantryFacadeWorkspaceConfig): Promise<string>;
export declare function resolveWritableWorkspacePath(relativePath: string, config: GantryFacadeWorkspaceConfig, toolName: 'FileWrite' | 'FileEdit'): Promise<string>;
export declare function writeFileNoFollow(target: string, content: string): Promise<void>;
