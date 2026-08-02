import { randomUUID } from 'node:crypto';
import { ConversationApproverPutRequestSchema, ConversationInstallRequestSchema, CreateProviderAccountRequestSchema, DiscoverProviderAccountRequestSchema, UpdateProviderAccountRequestSchema, } from '@gantry/contracts';
import { createRepositoryRuntimeSecretProvider } from '../../../adapters/credentials/repository-runtime-secret-provider.js';
import { RuntimeSecretConversationMembershipValidator } from '../../../channels/conversation-membership-validation.js';
import { BuiltInControlChannelProviderCatalog, RuntimeSecretConversationDiscovery, } from '../../../channels/control-provider-catalog.js';
import { ConversationAdministrationService } from '../../../application/provider-conversations/conversation-administration-service.js';
import { ConversationInstallControlService, ProviderAccountControlService, DiscoverProviderConversationsService, } from '../../../application/provider-conversations/provider-conversation-control-use-cases.js';
import { ListProvidersUseCase } from '../../../application/provider-conversations/list-providers-use-case.js';
import { ConversationControlService } from '../../../application/conversations/conversation-control-use-cases.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { nowIso } from '../app-identity.js';
import { authorizeControlRequest, } from '../handler-context.js';
import { readJson, sendApplicationError, sendError, sendJson, } from '../http.js';
import { parseConversationInstallRoute, parseProviderAccountRoute, parseConversationRoute, } from '../route-parser.js';
import { conversationInstallPatchFromParsed, conversationInstallToResponse, conversationToResponse, externalRefFromContract, messageToResponse, parseLimit, providerAccountToResponse, providerToResponse, threadToResponse, } from './provider-conversation-mappers.js';
import { projectConversationInstallToRuntime, projectProviderAccountRoutesToRuntime, removeProviderAccountRoutesFromRuntime, removeConversationInstallFromRuntime, } from './provider-conversation-live-routes.js';
const providers = new BuiltInControlChannelProviderCatalog();
function services(appId = 'default') {
    const repositories = getRuntimeStorage().repositories;
    const ids = { generate: randomUUID };
    const clock = { now: nowIso };
    const runtimeSecrets = createRepositoryRuntimeSecretProvider({
        appId,
        repository: repositories.capabilitySecrets,
    });
    return {
        providerAccounts: new ProviderAccountControlService({
            agents: repositories.agents,
            providerAccounts: repositories.providerAccounts,
            providers,
            ids,
            clock,
        }),
        discovery: new DiscoverProviderConversationsService({
            providerAccounts: repositories.providerAccounts,
            conversations: repositories.conversations,
            discovery: new RuntimeSecretConversationDiscovery(runtimeSecrets),
            ids,
            clock,
        }),
        conversations: new ConversationControlService({
            conversations: repositories.conversations,
            messages: repositories.messages,
        }),
        conversationInstalls: new ConversationInstallControlService({
            agents: repositories.agents,
            providerAccounts: repositories.providerAccounts,
            conversations: repositories.conversations,
            ids,
            clock,
        }),
    };
}
function parseConversationInstallPatch(appId, conversationId, raw) {
    const parsed = ConversationInstallRequestSchema.safeParse(raw);
    if (!parsed.success)
        return null;
    return conversationInstallPatchFromParsed(appId, conversationId, parsed.data);
}
export async function handleProviderConversationRoutes(req, res, ctx, url, pathname) {
    if (pathname === '/v1/providers' && req.method === 'GET') {
        const auth = authorizeControlRequest(req, res, ctx.keys, [
            'providers:read',
        ]);
        if (!auth)
            return true;
        const result = await new ListProvidersUseCase(providers).execute();
        sendJson(res, 200, {
            providers: result.providers.map(providerToResponse),
        });
        return true;
    }
    if (pathname === '/v1/provider-accounts' && req.method === 'GET') {
        const auth = authorizeControlRequest(req, res, ctx.keys, [
            'providers:read',
        ]);
        if (!auth)
            return true;
        const result = await services().providerAccounts.list(auth.appId);
        sendJson(res, 200, {
            providerAccounts: result.map(providerAccountToResponse),
        });
        return true;
    }
    if (pathname === '/v1/provider-accounts' && req.method === 'POST') {
        const auth = authorizeControlRequest(req, res, ctx.keys, [
            'providers:admin',
        ]);
        if (!auth)
            return true;
        const parsed = CreateProviderAccountRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
            sendError(res, 400, 'INVALID_REQUEST', 'Invalid provider account');
            return true;
        }
        if (parsed.data.appId !== auth.appId) {
            sendError(res, 403, 'FORBIDDEN', 'API key cannot create provider accounts for this app');
            return true;
        }
        try {
            const providerAccount = await services().providerAccounts.create({
                appId: auth.appId,
                agentId: parsed.data.agentId,
                providerId: parsed.data.providerId,
                label: parsed.data.label,
                config: parsed.data.config,
                externalInstallationRef: externalRefFromContract(parsed.data.externalRef, 'provider_account'),
                runtimeSecretRefs: parsed.data.runtimeSecretRefs,
                enabled: parsed.data.enabled,
            });
            await ctx.syncSettingsFromProjection(auth.appId);
            sendJson(res, 201, providerAccountToResponse(providerAccount));
        }
        catch (error) {
            if (!sendApplicationError(res, error))
                throw error;
        }
        return true;
    }
    const providerAccountRoute = parseProviderAccountRoute(pathname);
    if (providerAccountRoute?.action === 'get' && req.method === 'GET') {
        const auth = authorizeControlRequest(req, res, ctx.keys, [
            'providers:read',
        ]);
        if (!auth)
            return true;
        try {
            const providerAccount = await services().providerAccounts.get({
                appId: auth.appId,
                providerAccountId: providerAccountRoute.providerAccountId,
            });
            sendJson(res, 200, providerAccountToResponse(providerAccount));
        }
        catch (error) {
            if (!sendApplicationError(res, error))
                throw error;
        }
        return true;
    }
    if (providerAccountRoute?.action === 'get' && req.method === 'PATCH') {
        const auth = authorizeControlRequest(req, res, ctx.keys, [
            'providers:admin',
        ]);
        if (!auth)
            return true;
        const parsed = UpdateProviderAccountRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
            sendError(res, 400, 'INVALID_REQUEST', 'Invalid provider account patch');
            return true;
        }
        try {
            const providerAccountService = services().providerAccounts;
            const providerAccount = await providerAccountService.update({
                appId: auth.appId,
                providerAccountId: providerAccountRoute.providerAccountId,
                patch: {
                    label: parsed.data.label,
                    status: parsed.data.status,
                    enabled: parsed.data.enabled,
                    config: parsed.data.config,
                    externalInstallationRef: parsed.data.externalRef === null
                        ? null
                        : externalRefFromContract(parsed.data.externalRef, 'provider_account'),
                    runtimeSecretRefs: parsed.data.runtimeSecretRefs,
                },
            });
            if (providerAccount.status === 'disabled') {
                await removeProviderAccountRoutesFromRuntime(ctx, providerAccount.id);
            }
            else {
                await projectProviderAccountRoutesToRuntime(ctx, providerAccount.id);
            }
            await ctx.syncSettingsFromProjection(auth.appId, parsed.data.runtimeSecretRefs === undefined
                ? undefined
                : {
                    providerAccount: {
                        id: providerAccount.id,
                        runtimeSecretRefs: parsed.data.runtimeSecretRefs,
                    },
                });
            sendJson(res, 200, providerAccountToResponse(providerAccount));
        }
        catch (error) {
            if (!sendApplicationError(res, error))
                throw error;
        }
        return true;
    }
    if (providerAccountRoute?.action === 'get' && req.method === 'DELETE') {
        const auth = authorizeControlRequest(req, res, ctx.keys, [
            'providers:admin',
        ]);
        if (!auth)
            return true;
        try {
            const providerAccount = await services().providerAccounts.disable({
                appId: auth.appId,
                providerAccountId: providerAccountRoute.providerAccountId,
            });
            await removeProviderAccountRoutesFromRuntime(ctx, providerAccount.id);
            await ctx.syncSettingsFromProjection(auth.appId);
            sendJson(res, 200, {
                deleted: true,
                providerAccount: providerAccountToResponse(providerAccount),
            });
        }
        catch (error) {
            if (!sendApplicationError(res, error))
                throw error;
        }
        return true;
    }
    if (providerAccountRoute?.action === 'discover' && req.method === 'POST') {
        const auth = authorizeControlRequest(req, res, ctx.keys, [
            'providers:admin',
        ]);
        if (!auth)
            return true;
        const parsed = DiscoverProviderAccountRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
            sendError(res, 400, 'INVALID_REQUEST', 'Invalid discovery request');
            return true;
        }
        try {
            const conversations = await services(auth.appId).discovery.execute({
                appId: auth.appId,
                providerAccountId: providerAccountRoute.providerAccountId,
                query: parsed.data.query,
                limit: parsed.data.limit,
                includeArchived: parsed.data.includeArchived,
                providerMetadata: parsed.data.providerMetadata,
            });
            sendJson(res, 200, {
                conversations: conversations.map(conversationToResponse),
            });
        }
        catch (error) {
            if (!sendApplicationError(res, error))
                throw error;
        }
        return true;
    }
    if (pathname === '/v1/conversations' && req.method === 'GET') {
        const auth = authorizeControlRequest(req, res, ctx.keys, [
            'conversations:read',
        ]);
        if (!auth)
            return true;
        const conversations = await services().conversations.list({
            appId: auth.appId,
            providerAccountId: url.searchParams.get('providerAccountId') ?? undefined,
        });
        sendJson(res, 200, {
            conversations: conversations.map(conversationToResponse),
        });
        return true;
    }
    const conversationRoute = parseConversationRoute(pathname);
    if (conversationRoute?.action === 'get' && req.method === 'GET') {
        const auth = authorizeControlRequest(req, res, ctx.keys, [
            'conversations:read',
        ]);
        if (!auth)
            return true;
        try {
            const conversation = await services().conversations.get({
                appId: auth.appId,
                conversationId: conversationRoute.conversationId,
            });
            sendJson(res, 200, conversationToResponse(conversation));
        }
        catch (error) {
            if (!sendApplicationError(res, error))
                throw error;
        }
        return true;
    }
    const approversMatch = /^\/v1\/conversations\/([^/]+)\/approvers$/.exec(pathname);
    if (approversMatch && req.method === 'GET') {
        const auth = authorizeControlRequest(req, res, ctx.keys, [
            'conversations:read',
        ]);
        if (!auth)
            return true;
        try {
            const summary = await new ConversationAdministrationService({
                providerAccounts: getRuntimeStorage().repositories.providerAccounts,
                conversations: getRuntimeStorage().repositories.conversations,
            }).getAdminSummary({
                appId: auth.appId,
                conversationId: decodeURIComponent(approversMatch[1]),
            });
            sendJson(res, 200, { approvers: summary.controlAllowlist });
        }
        catch (error) {
            if (!sendApplicationError(res, error))
                throw error;
        }
        return true;
    }
    if (approversMatch && req.method === 'PUT') {
        const auth = authorizeControlRequest(req, res, ctx.keys, [
            'conversations:admin',
        ]);
        if (!auth)
            return true;
        const parsed = ConversationApproverPutRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
            sendError(res, 400, 'INVALID_REQUEST', 'Invalid conversation approver request');
            return true;
        }
        try {
            const result = await new ConversationAdministrationService({
                providerAccounts: getRuntimeStorage().repositories.providerAccounts,
                conversations: getRuntimeStorage().repositories.conversations,
            }, new RuntimeSecretConversationMembershipValidator(createRepositoryRuntimeSecretProvider({
                appId: auth.appId,
                repository: getRuntimeStorage().repositories.capabilitySecrets,
            }))).replaceControlAllowlist({
                appId: auth.appId,
                conversationId: decodeURIComponent(approversMatch[1]),
                userIds: parsed.data.userIds,
                updatedAt: nowIso(),
            });
            await ctx.syncSettingsFromProjection(auth.appId);
            sendJson(res, 200, { approvers: result });
        }
        catch (error) {
            if (!sendApplicationError(res, error))
                throw error;
        }
        return true;
    }
    if (conversationRoute?.action === 'threads' && req.method === 'GET') {
        const auth = authorizeControlRequest(req, res, ctx.keys, [
            'conversations:read',
        ]);
        if (!auth)
            return true;
        try {
            const threads = await services().conversations.listThreads({
                appId: auth.appId,
                conversationId: conversationRoute.conversationId,
            });
            sendJson(res, 200, { threads: threads.map(threadToResponse) });
        }
        catch (error) {
            if (!sendApplicationError(res, error))
                throw error;
        }
        return true;
    }
    if (conversationRoute?.action === 'messages' && req.method === 'GET') {
        const auth = authorizeControlRequest(req, res, ctx.keys, ['messages:read']);
        if (!auth)
            return true;
        try {
            const messages = await services().conversations.listMessages({
                appId: auth.appId,
                conversationId: conversationRoute.conversationId,
                threadId: url.searchParams.get('threadId') ??
                    undefined,
                after: url.searchParams.get('after') ?? undefined,
                limit: parseLimit(url.searchParams.get('limit')),
            });
            sendJson(res, 200, { messages: messages.map(messageToResponse) });
        }
        catch (error) {
            if (!sendApplicationError(res, error))
                throw error;
        }
        return true;
    }
    const installRoute = parseConversationInstallRoute(pathname);
    if (installRoute?.action === 'list' && req.method === 'GET') {
        const auth = authorizeControlRequest(req, res, ctx.keys, [
            'conversations:read',
        ]);
        if (!auth)
            return true;
        try {
            const conversationInstalls = await services().conversationInstalls.list({
                appId: auth.appId,
                agentId: installRoute.agentId,
            });
            sendJson(res, 200, {
                conversationInstalls: conversationInstalls.map(conversationInstallToResponse),
            });
        }
        catch (error) {
            if (!sendApplicationError(res, error))
                throw error;
        }
        return true;
    }
    if (installRoute?.action === 'install' && req.method === 'PUT') {
        const auth = authorizeControlRequest(req, res, ctx.keys, [
            'agents:admin',
            'conversations:admin',
        ]);
        if (!auth)
            return true;
        const patch = parseConversationInstallPatch(auth.appId, installRoute.conversationId, await readJson(req));
        if (!patch) {
            sendError(res, 400, 'INVALID_REQUEST', 'Invalid conversation install request');
            return true;
        }
        try {
            const install = await services().conversationInstalls.enable({
                appId: auth.appId,
                agentId: installRoute.agentId,
                conversationId: installRoute.conversationId,
                patch,
            });
            await projectConversationInstallToRuntime(ctx, install);
            await ctx.syncSettingsFromProjection(auth.appId);
            sendJson(res, 200, conversationInstallToResponse(install));
        }
        catch (error) {
            if (!sendApplicationError(res, error))
                throw error;
        }
        return true;
    }
    if (installRoute?.action === 'install' && req.method === 'PATCH') {
        const auth = authorizeControlRequest(req, res, ctx.keys, [
            'agents:admin',
            'conversations:admin',
        ]);
        if (!auth)
            return true;
        const patch = parseConversationInstallPatch(auth.appId, installRoute.conversationId, await readJson(req));
        if (!patch) {
            sendError(res, 400, 'INVALID_REQUEST', 'Invalid conversation install patch');
            return true;
        }
        try {
            const install = await services().conversationInstalls.update({
                appId: auth.appId,
                agentId: installRoute.agentId,
                conversationId: installRoute.conversationId,
                patch,
            });
            await projectConversationInstallToRuntime(ctx, install);
            await ctx.syncSettingsFromProjection(auth.appId);
            sendJson(res, 200, conversationInstallToResponse(install));
        }
        catch (error) {
            if (!sendApplicationError(res, error))
                throw error;
        }
        return true;
    }
    if (installRoute?.action === 'install' && req.method === 'DELETE') {
        const auth = authorizeControlRequest(req, res, ctx.keys, [
            'agents:admin',
            'conversations:admin',
        ]);
        if (!auth)
            return true;
        try {
            const install = await services().conversationInstalls.disable({
                appId: auth.appId,
                agentId: installRoute.agentId,
                conversationId: installRoute.conversationId,
                threadId: url.searchParams.get('threadId') ??
                    undefined,
            });
            await removeConversationInstallFromRuntime(ctx, install);
            await ctx.syncSettingsFromProjection(auth.appId);
            sendJson(res, 200, {
                disabled: true,
                conversationInstall: conversationInstallToResponse(install),
            });
        }
        catch (error) {
            if (!sendApplicationError(res, error))
                throw error;
        }
        return true;
    }
    return false;
}
