type MemoryScope = 'user' | 'group' | 'global';
interface MemoryToolContext {
    memoryDefaultScope: Exclude<MemoryScope, 'global'>;
    memoryUserId?: string;
}
interface MemorySaveArgs {
    scope?: MemoryScope;
    [key: string]: unknown;
}
export declare function buildMemorySavePayload<T extends MemorySaveArgs>(args: T, ctx: MemoryToolContext): T & {
    scope: MemoryScope;
};
export declare function buildProcedureSavePayload<T extends MemorySaveArgs>(args: T, ctx: MemoryToolContext): T & {
    scope: MemoryScope;
};
export {};
