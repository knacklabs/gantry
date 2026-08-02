type MemoryScope = 'user' | 'group' | 'global';

interface MemoryToolContext {
  memoryDefaultScope: Exclude<MemoryScope, 'global'>;
  memoryUserId?: string;
}

interface MemorySaveArgs {
  scope?: MemoryScope;
  [key: string]: unknown;
}

export function buildMemorySavePayload<T extends MemorySaveArgs>(
  args: T,
  ctx: MemoryToolContext,
): T & { scope: MemoryScope } {
  const safeArgs = { ...args };
  delete (safeArgs as { user_id?: string }).user_id;
  return {
    ...(safeArgs as T),
    scope: ctx.memoryDefaultScope,
  };
}

export function buildProcedureSavePayload<T extends MemorySaveArgs>(
  args: T,
  ctx: MemoryToolContext,
): T & { scope: MemoryScope } {
  return buildMemorySavePayload(args, ctx);
}
