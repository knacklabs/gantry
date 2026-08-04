export function buildMemorySavePayload(args, ctx) {
    const safeArgs = { ...args };
    delete safeArgs.user_id;
    return {
        ...safeArgs,
        scope: args.scope || ctx.memoryDefaultScope,
    };
}
export function buildProcedureSavePayload(args, ctx) {
    return buildMemorySavePayload(args, ctx);
}
