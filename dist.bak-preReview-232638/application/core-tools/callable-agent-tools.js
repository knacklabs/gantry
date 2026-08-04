import { agentIdForFolder, folderForAgentId, } from '../../domain/agent/agent-folder-id.js';
import { CALLABLE_AGENT_SYNC_WAIT_TIMEOUT_MS, CALLABLE_AGENT_TOOL_PREFIX, callableAgentToolDescription, callableAgentToolName, } from '../../shared/callable-agent-manifest.js';
import { resolveAgentPersona } from '../../shared/agent-persona.js';
import { sanitizeOutboundLlmText } from '../../shared/sensitive-material.js';
import { sha256Base64Url } from '../../shared/stable-hash.js';
import { findConversationRouteForQueue, makeAgentThreadQueueKey, parseAgentThreadQueueKey, routesForConversationId, } from '../../shared/thread-queue-key.js';
import { coreTaskLifecycleResultText } from './task-lifecycle.js';
import { sendCoreMessage } from './send-message.js';
const CALLABLE_AGENT_NARRATION_TIMEOUT_MS = 5_000;
const CALLABLE_AGENT_NARRATION_SNIPPET_MAX_CHARS = 160;
const CALLABLE_AGENT_WARNING_FIELD_MAX_CHARS = 160;
export { CALLABLE_AGENT_RESPONSE_TIMEOUT_MS, CALLABLE_AGENT_SYNC_WAIT_MAX_MS, CALLABLE_AGENT_SYNC_WAIT_TIMEOUT_MS, CALLABLE_AGENT_TOOL_PREFIX, callableAgentToolName, createCallableAgentToolSchema, parseCallableAgentManifest, } from '../../shared/callable-agent-manifest.js';
export function isCallableAgentToolName(name) {
    return name.startsWith(CALLABLE_AGENT_TOOL_PREFIX);
}
export function createCallableAgentToolDefinitions(input) {
    return input.manifest.map((entry) => ({
        name: callableAgentToolName(entry),
        description: callableAgentToolDescription(entry),
        inputSchema: input.schema,
        handler: async (args) => coreTaskLifecycleMcpResult(await input.dispatch(entry, args)),
    }));
}
export function coreTaskLifecycleMcpResult(result) {
    const text = coreTaskLifecycleResultText(result);
    return {
        content: [{ type: 'text', text }],
        ...(result.ok
            ? {}
            : { isError: true, error: taskLifecycleError(result.code, text) }),
    };
}
function taskLifecycleError(code, message) {
    switch (code) {
        case 'unavailable':
            return { category: 'transient', isRetryable: true, message };
        case 'invalid_request':
            return { category: 'validation', isRetryable: false, message };
        case 'forbidden':
            return { category: 'permission', isRetryable: false, message };
        case 'failed':
            return { category: 'business', isRetryable: false, message };
        case 'not_found':
        default:
            return { category: 'business', isRetryable: false, message };
    }
}
export function projectCallableAgentTools(input) {
    if (input.parentTaskId != null ||
        !input.toolPolicyRules?.includes('AgentDelegation') ||
        input.delegates.length === 0) {
        return [];
    }
    const callerIds = new Set([
        input.callerAgentId,
        String(agentIdForFolder(input.callerFolder)),
    ]);
    const byIdentity = new Map();
    for (const agent of input.agents) {
        if (String(agent.appId) !== input.callerAppId ||
            agent.status !== 'active' ||
            callerIds.has(String(agent.id))) {
            continue;
        }
        byIdentity.set(String(agent.id), agent);
        const folder = folderForAgentId(agent.id);
        if (folder)
            byIdentity.set(folder, agent);
    }
    const seen = new Set();
    const warnedUnresolved = new Set();
    return input.delegates.flatMap((delegate) => {
        const agent = byIdentity.get(delegate) ??
            byIdentity.get(String(agentIdForFolder(delegate)));
        if (!agent) {
            if (!warnedUnresolved.has(delegate)) {
                warnedUnresolved.add(delegate);
                input.warn?.({
                    ownerAgentId: input.callerAgentId.slice(0, CALLABLE_AGENT_WARNING_FIELD_MAX_CHARS),
                    ownerAgentFolder: input.callerFolder.slice(0, CALLABLE_AGENT_WARNING_FIELD_MAX_CHARS),
                    delegateRef: delegate.slice(0, CALLABLE_AGENT_WARNING_FIELD_MAX_CHARS),
                }, 'Configured callable-agent delegate did not resolve to an active same-app non-self agent');
            }
            return [];
        }
        const agentId = String(agent.id);
        if (seen.has(agentId) || !input.conversationBoundAgentIds.has(agentId)) {
            return [];
        }
        seen.add(agentId);
        const displayName = (agent.name.replace(/\s+/g, ' ').trim() ||
            folderForAgentId(agent.id) ||
            String(agent.id)).slice(0, 200);
        return [
            {
                toolName: immutableToolName(String(agent.id)),
                targetAgentId: agentId,
                displayName,
                persona: resolveAgentPersona(input.personasByAgentId?.[agentId]),
            },
        ];
    });
}
export function conversationBoundAgentIdsForRoute(input) {
    const callerRoute = conversationRouteForAgent({
        ...input,
        agentId: input.callerAgentId,
        providerAccountId: input.callerProviderAccountId,
    });
    const scopedRoutes = routesForConversationId(input.routes, callerRoute?.conversationId);
    const normalizedThreadId = input.threadId?.trim() || undefined;
    const routesByAgentId = new Map();
    for (const [routeKey, route] of Object.entries(scopedRoutes)) {
        const parsed = parseAgentThreadQueueKey(routeKey);
        if (parsed.chatJid !== input.chatJid)
            continue;
        const agentId = parsed.agentId ?? route.agentId ?? String(agentIdForFolder(route.folder));
        const providerAccountId = parsed.providerAccountId ?? route.providerAccountId ?? '';
        const bucket = routesByAgentId.get(agentId) ?? {
            exactProviders: new Set(),
            wholeProviders: new Set(),
        };
        if (parsed.threadId) {
            if (normalizedThreadId && parsed.threadId === normalizedThreadId) {
                bucket.exactProviders.add(providerAccountId);
            }
        }
        else {
            bucket.wholeProviders.add(providerAccountId);
        }
        routesByAgentId.set(agentId, bucket);
    }
    return new Set([...routesByAgentId].flatMap(([agentId, { exactProviders, wholeProviders }]) => {
        const providers = normalizedThreadId && exactProviders.size > 0
            ? exactProviders
            : wholeProviders;
        return providers.size === 1 ? [agentId] : [];
    }));
}
export function conversationBoundAgentRoute(input) {
    const callerRoute = conversationRouteForAgent({
        ...input,
        agentId: input.callerAgentId,
        providerAccountId: input.callerProviderAccountId,
    });
    if (!callerRoute?.conversationId)
        return undefined;
    if (input.targetAgentId === input.callerAgentId)
        return callerRoute;
    return conversationRouteForAgent({
        routes: routesForConversationId(input.routes, callerRoute.conversationId),
        chatJid: input.chatJid,
        threadId: input.threadId,
        agentId: input.targetAgentId,
    });
}
function conversationRouteForAgent(input) {
    return findConversationRouteForQueue(input.routes, makeAgentThreadQueueKey(input.chatJid, input.agentId, input.threadId, input.providerAccountId), (route) => route.agentId ?? String(agentIdForFolder(route.folder)));
}
export async function preloadCallableAgentManifest(input) {
    const { run } = input;
    if (!input.toolsAvailable ||
        run.parentTaskId != null ||
        !run.toolPolicyRules?.includes('AgentDelegation') ||
        !run.appId ||
        !run.agentId ||
        input.delegates.length === 0 ||
        !input.getRepository) {
        return [];
    }
    return projectCallableAgentTools({
        agents: await input.getRepository().listAgents(run.appId),
        callerAppId: run.appId,
        callerAgentId: run.agentId,
        callerFolder: input.callerFolder,
        delegates: input.delegates,
        conversationBoundAgentIds: input.conversationBoundAgentIds,
        personasByAgentId: input.personasByAgentId,
        toolPolicyRules: run.toolPolicyRules,
        parentTaskId: run.parentTaskId,
        warn: input.warn,
    });
}
export async function dispatchCallableAgentTool(input) {
    if (Object.prototype.hasOwnProperty.call(input.args, 'targetAgentId')) {
        return {
            ok: false,
            message: 'Callable agent tools do not accept targetAgentId.',
            code: 'invalid_request',
        };
    }
    if (!(await input.revalidate(input.entry))) {
        return {
            ok: false,
            message: 'Callable agent target is no longer permitted.',
            code: 'forbidden',
        };
    }
    const objective = narrationSnippet(input.args.objective);
    await narrate(input, `Checking with the ${input.entry.displayName} agent${objective ? ` about: ${objective}` : ''}…`);
    if (!(await input.revalidate(input.entry))) {
        void narrate(input, `${input.entry.displayName} is no longer available.`);
        return {
            ok: false,
            message: 'Callable agent target is no longer permitted.',
            code: 'forbidden',
        };
    }
    const result = await input.backend.delegate_task({
        ...input.args,
        targetAgentId: input.entry.targetAgentId,
        syncWaitTimeoutMs: typeof input.args.syncWaitTimeoutMs === 'number'
            ? input.args.syncWaitTimeoutMs
            : CALLABLE_AGENT_SYNC_WAIT_TIMEOUT_MS,
    });
    const status = typeof result.data === 'object' && result.data !== null
        ? result.data.status
        : undefined;
    if (result.ok && status === 'completed') {
        void narrate(input, `${input.entry.displayName} responded.`);
    }
    else if (result.ok && (status === 'queued' || status === 'running')) {
        void narrate(input, `${input.entry.displayName} is still working; I'll follow up.`);
    }
    else if (!result.ok) {
        const reason = narrationSnippet(result.message);
        void narrate(input, `Delegation to ${input.entry.displayName} failed${reason ? `: ${reason}` : '.'}`);
    }
    return result;
}
function narrationSnippet(value) {
    if (typeof value !== 'string')
        return '';
    const sanitized = sanitizeOutboundLlmText(value);
    const text = (sanitized.blocked ? 'Sensitive detail hidden.' : sanitized.text)
        .replace(/\s+/g, ' ')
        .trim();
    if (text.length <= CALLABLE_AGENT_NARRATION_SNIPPET_MAX_CHARS)
        return text;
    return `${text
        .slice(0, CALLABLE_AGENT_NARRATION_SNIPPET_MAX_CHARS - 1)
        .trimEnd()}…`;
}
async function narrate(input, text) {
    const owner = input.backend.owner;
    if (!input.narration || !owner)
        return;
    let timeout;
    try {
        await Promise.race([
            sendCoreMessage({
                message: { text },
                context: {
                    appId: owner.appId,
                    sourceAgentFolder: input.narration.sourceAgentFolder,
                    targetJid: owner.conversationId,
                    providerAccountId: owner.providerAccountId ?? undefined,
                    threadId: owner.threadId ?? undefined,
                    isScheduledJob: input.narration.isScheduledJob,
                },
                deps: input.narration.deps,
            }),
            new Promise((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error('Narration delivery timed out.')), CALLABLE_AGENT_NARRATION_TIMEOUT_MS);
                timeout.unref?.();
            }),
        ]);
    }
    catch (error) {
        input.narration.deps.warn({
            toolName: `${CALLABLE_AGENT_TOOL_PREFIX}${input.entry.toolName}`,
            error: error instanceof Error ? error.message : String(error),
        }, 'Callable-agent narration delivery failed');
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
}
function immutableToolName(agentId) {
    const identity = folderForAgentId(agentId) ?? agentId;
    const stem = identity
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 8) || 'agent';
    // Leaves room for the fully qualified facade name within the shared 64-char cap.
    const digest = sha256Base64Url(agentId).slice(0, 30);
    return `${stem}_${digest}`;
}
