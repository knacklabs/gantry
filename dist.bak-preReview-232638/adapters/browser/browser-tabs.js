const tabIndexMappings = new Map();
export function clearBrowserTabIndexMappings(profileName) {
    for (const key of [...tabIndexMappings.keys()]) {
        if (!profileName || key.startsWith(`${profileName}\0`)) {
            tabIndexMappings.delete(key);
        }
    }
}
export function translateBrowserTabsInput(toolName, args, sessionKey) {
    if (toolName !== 'tabs')
        return args;
    const action = args.action;
    if (action !== 'select' && action !== 'close')
        return args;
    const index = args.index;
    if (typeof index !== 'number' ||
        !Number.isFinite(index) ||
        !Number.isInteger(index)) {
        throw new Error(`Browser tab ${action} requires an integer numeric index.`);
    }
    const visibleIndex = index;
    const mapping = tabIndexMappings.get(sessionKey);
    if (!mapping) {
        throw new Error(`Browser tab ${action} needs a fresh tabs list before using visible index ${visibleIndex}.`);
    }
    const backendIndex = mapping.get(visibleIndex);
    if (backendIndex === undefined) {
        throw new Error(`Browser tab ${action} index ${visibleIndex} is not in the current visible tab list. Run tabs list to refresh.`);
    }
    return { ...args, index: backendIndex };
}
export function projectBrowserTabsResult(result, sessionKey, toolName, args = {}) {
    if (!result || typeof result !== 'object' || Array.isArray(result))
        return result;
    const record = result;
    const isBrowserTabsList = toolName === 'tabs' && args.action === 'list';
    const isBrowserTabsMutation = toolName === 'tabs' && (args.action === 'close' || args.action === 'new');
    const structuredContent = record.structuredContent;
    if (!structuredContent ||
        typeof structuredContent !== 'object' ||
        Array.isArray(structuredContent)) {
        if ((isBrowserTabsList || isBrowserTabsMutation) && sessionKey)
            tabIndexMappings.delete(sessionKey);
        if (isBrowserTabsList)
            return unsafeBrowserTabsListResult(sessionKey);
        return result;
    }
    const tabs = structuredContent.tabs;
    if (!Array.isArray(tabs)) {
        if ((isBrowserTabsList || isBrowserTabsMutation) && sessionKey)
            tabIndexMappings.delete(sessionKey);
        if (isBrowserTabsList)
            return unsafeBrowserTabsListResult(sessionKey);
        return result;
    }
    return projectStructuredBrowserTabsResult(record, structuredContent, sessionKey);
}
function projectStructuredBrowserTabsResult(record, structuredContent, sessionKey) {
    const tabs = structuredContent.tabs;
    if (!Array.isArray(tabs))
        return record;
    const indexProjection = new Map();
    const userToBackend = new Map();
    const projectedTabs = tabs.map((tab, userIndex) => {
        if (!tab || typeof tab !== 'object' || Array.isArray(tab))
            return tab;
        const backendIndex = numericTabIndex(tab.index);
        if (backendIndex !== undefined) {
            indexProjection.set(backendIndex, userIndex);
            userToBackend.set(userIndex, backendIndex);
        }
        return { ...tab, index: userIndex };
    });
    if (sessionKey)
        tabIndexMappings.set(sessionKey, userToBackend);
    return {
        ...record,
        content: rewriteBrowserTabContent(record.content, indexProjection),
        structuredContent: {
            ...structuredContent,
            tabs: projectedTabs,
        },
    };
}
function unsafeBrowserTabsListResult(sessionKey) {
    if (sessionKey)
        tabIndexMappings.delete(sessionKey);
    return {
        content: [
            {
                type: 'text',
                text: 'Browser tab list failed closed because the backend did not return structured tab metadata.',
            },
        ],
        isError: true,
    };
}
const numericTabIndex = (value) => typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
    ? value
    : undefined;
function rewriteBrowserTabContent(content, indexProjection) {
    if (!Array.isArray(content) || indexProjection.size === 0)
        return content;
    return content.map((block) => {
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
            return block;
        }
        const row = block;
        if (row.type !== 'text' || typeof row.text !== 'string')
            return block;
        return {
            ...row,
            text: row.text
                .split('\n')
                .map((line) => rewriteBrowserTabLine(line, indexProjection))
                .join('\n'),
        };
    });
}
function rewriteBrowserTabLine(line, indexProjection) {
    return line.replace(/^(\s*-\s*)(\d+)(:\s*)/, (match, prefix, raw, suffix) => {
        const projected = indexProjection.get(Number(raw));
        return projected === undefined ? match : `${prefix}${projected}${suffix}`;
    });
}
