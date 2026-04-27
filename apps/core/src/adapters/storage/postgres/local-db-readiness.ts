import { redactString } from '../../../infrastructure/logging/logger.js';
import { evaluatePostgresStorageCapabilities } from './readiness.js';
import {
  createStorageService,
  type ResolvedStorageConfig,
} from './storage-service.js';

export async function migrateAndVerifyPostgres(
  config: ResolvedStorageConfig,
): Promise<{ ok: boolean; details?: string[] }> {
  const service = createStorageService(config);
  try {
    await service.migrate();
    const capabilities = await service.healthCheck();
    const failure = evaluatePostgresStorageCapabilities(capabilities);
    if (failure) {
      return { ok: false, details: [failure.summary, ...failure.details] };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      details: [redactString(err instanceof Error ? err.message : String(err))],
    };
  } finally {
    await service.close().catch(() => undefined);
  }
}
