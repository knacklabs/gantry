export interface PostgresMigrateConfig {
    url: string;
    schema: string;
}
export declare function resolvePostgresMigrateConfig(): PostgresMigrateConfig;
export declare function runPostgresMigrations(config?: PostgresMigrateConfig): Promise<void>;
