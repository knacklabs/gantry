import { getRuntimeStorage } from './runtime-store.js';
export function getRuntimeToolRepositoryIfReady() {
    try {
        return getRuntimeStorage().repositories.tools;
    }
    catch {
        return undefined;
    }
}
