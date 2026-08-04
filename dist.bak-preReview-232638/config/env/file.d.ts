import { type EnvMap } from '../../shared/env-file.js';
export type { EnvMap } from '../../shared/env-file.js';
export { parseEnvContent } from '../../shared/env-file.js';
export declare function readEnvFile(filePath: string): EnvMap;
export declare function writeEnvFile(filePath: string, env: EnvMap): void;
export declare function upsertEnvFile(filePath: string, updates: Record<string, string | null | undefined>): EnvMap;
