function renderAllow(allow) {
    if (allow === '*')
        return '*';
    return allow.length > 0 ? allow.join(',') : '(none)';
}
export function printPolicyChannel(providerId, settings) {
    const provider = settings.providers[providerId];
    const entries = Object.entries(settings.bindings)
        .map(([, binding]) => {
        const conversation = settings.conversations[binding.conversation];
        if (!conversation)
            return null;
        const connection = settings.providerAccounts[conversation.providerAccount];
        if (connection?.provider !== providerId)
            return null;
        return [binding.agent, conversation.senderPolicy];
    })
        .filter((entry) => Boolean(entry))
        .sort(([a], [b]) => a.localeCompare(b));
    const lines = [
        `${providerId}:`,
        `  enabled: ${provider?.enabled ? 'yes' : 'no'}`,
        '  agents:',
    ];
    if (entries.length === 0) {
        lines.push('    (none)');
    }
    else {
        for (const [folder, entry] of entries) {
            lines.push(`    ${folder}: allow=${renderAllow(entry.allow)} mode=${entry.mode}`);
        }
    }
    console.log(lines.join('\n'));
}
