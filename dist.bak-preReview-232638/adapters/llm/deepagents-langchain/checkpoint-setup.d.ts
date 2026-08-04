export declare const DEEPAGENTS_CHECKPOINT_PACKAGE_NAME = "@langchain/langgraph-checkpoint-postgres";
export declare function ensureDeepAgentsCheckpointSchema(input: {
    databaseUrl: string;
    schema: string;
}): Promise<void>;
