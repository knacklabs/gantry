import type { ToolCatalogRepository } from '../../../domain/ports/repositories.js';
import { getRuntimeStorage } from './runtime-store.js';

export function getRuntimeToolRepositoryIfReady():
  ToolCatalogRepository | undefined {
  try {
    return getRuntimeStorage().repositories.tools;
  } catch {
    return undefined;
  }
}
