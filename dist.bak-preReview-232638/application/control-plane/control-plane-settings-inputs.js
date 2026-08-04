export function controlPlaneProviderInputs(settings) {
    const accountProviders = new Set(Object.values(settings.providerAccounts ?? {}).map((account) => account.provider));
    const providerIds = new Set([
        ...Object.keys(settings.providers ?? {}),
        ...accountProviders,
    ]);
    return [...providerIds]
        .filter((id) => settings.providers?.[id]?.enabled === true || accountProviders.has(id))
        .map((id) => ({
        id,
        label: id,
        ready: (settings.providers?.[id]?.enabled === true ||
            settings.providers?.[id] === undefined) &&
            accountProviders.has(id),
    }));
}
export function controlPlaneMemoryStatus(enabled) {
    return enabled ? 'Ready' : 'Disabled';
}
export function controlPlaneJobStatus(status) {
    if (status === 'dead_lettered')
        return 'blocked';
    if (status === 'paused')
        return 'needs_action';
    return 'ready';
}
