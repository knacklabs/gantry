import fs from 'fs';
import path from 'path';
import { isForbiddenRuntimeSecretEnvName, runtimeSecretRefTarget, } from '../../domain/ports/runtime-secret-provider.js';
import { getGantryHome } from '../../shared/gantry-home.js';
import { parseEnvContent } from '../../shared/env-file.js';
let cachedRuntimeEnv;
function readRuntimeHomeEnvValues() {
    const envPath = path.join(getGantryHome(), '.env');
    try {
        const stat = fs.statSync(envPath);
        if (cachedRuntimeEnv &&
            cachedRuntimeEnv.path === envPath &&
            cachedRuntimeEnv.mtimeMs === stat.mtimeMs) {
            return cachedRuntimeEnv.values;
        }
        const raw = fs.readFileSync(envPath, 'utf8');
        const values = new Map(Object.entries(parseEnvContent(raw)));
        cachedRuntimeEnv = { path: envPath, mtimeMs: stat.mtimeMs, values };
        return values;
    }
    catch {
        cachedRuntimeEnv = undefined;
        return new Map();
    }
}
export class EnvRuntimeSecretProvider {
    source;
    constructor(source = process.env) {
        this.source = source;
    }
    getSecret(ref) {
        const value = this.getOptionalSecret(ref);
        if (!value) {
            throw new Error(`${runtimeSecretRefTarget(ref).name} is required.`);
        }
        return value;
    }
    getOptionalSecret(ref) {
        const target = runtimeSecretRefTarget(ref);
        if (target.source !== 'env')
            return undefined;
        if (isForbiddenRuntimeSecretEnvName(target.name))
            return undefined;
        const direct = this.source[target.name]?.trim();
        if (direct)
            return direct;
        if (this.source !== process.env)
            return undefined;
        const runtimeValue = readRuntimeHomeEnvValues().get(target.name)?.trim();
        return runtimeValue || undefined;
    }
    async healthCheck(refs = []) {
        const missing = refs
            .filter((ref) => !this.getOptionalSecret(ref))
            .map((ref) => runtimeSecretRefTarget(ref).name);
        if (missing.length > 0) {
            return {
                status: 'fail',
                message: 'Runtime-owned secrets are missing.',
                details: missing,
            };
        }
        return {
            status: 'pass',
            message: 'Runtime-owned secrets are configured.',
        };
    }
}
