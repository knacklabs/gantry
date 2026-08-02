export declare const GENERATED_RUNTIME_SKILL_PATH_DURABLE_REJECTION_REASON = "Persistent RunCommand rules cannot reference generated runtime skill paths; approve the selected skill action capability or a stable reviewed command wrapper instead.";
export declare function containsGeneratedRuntimeSkillPath(input: string): boolean;
export declare function canonicalizeGeneratedRuntimeSkillPaths(input: string): string;
export declare function generatedRuntimeSkillPathDisplay(input: string): string | null;
export declare function isGeneratedRuntimeToolResultPath(input: string): boolean;
export declare function containsGeneratedRuntimePath(input: string): boolean;
