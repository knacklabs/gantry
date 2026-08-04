import { defaultProvider as fromNodeProviderChain } from '@aws-sdk/credential-provider-node';
import { getVertexAdcBearerToken, getVertexServiceAccountBearerToken, } from '../adapters/llm/anthropic-claude-agent/gantry-model-gateway-auth-vertex.js';
import { injectProviderAuth, resolveGatewayUpstream, } from '../adapters/llm/anthropic-claude-agent/gantry-model-gateway-routing.js';
import { resolveModelCredentialSecretRef } from '../adapters/llm/anthropic-claude-agent/gantry-model-gateway-secret-ref.js';
import { getModelProviderDefinition, } from '../shared/model-provider-registry.js';
import { getProviderRuntimeSecret } from '../channels/provider-runtime-secrets.js';
import { createRepositoryRuntimeSecretProvider } from '../adapters/credentials/repository-runtime-secret-provider.js';
import { normalizeRuntimeSecretRefString, parseRuntimeSecretRefString, } from '../domain/ports/runtime-secret-provider.js';
import { validateSlackAppToken, validateSlackBotToken } from './slack.js';
import { validateTelegramBotToken } from './telegram.js';
import { resolveTelegramTokenForDoctor } from './telegram-doctor-token.js';
import { resolveRuntimeEnvValue } from './runtime-credential-check.js';
const SLACK_CHANNEL_TOKEN_NEXT_ACTION = 're-run `gantry provider connect slack`, then `gantry restart`';
const TELEGRAM_CHANNEL_TOKEN_NEXT_ACTION = 're-run `gantry provider connect telegram`, then `gantry restart`';
export async function verifyModelProviderCredentialLive(input) {
    const provider = getModelProviderDefinition(input.providerId);
    if (!provider) {
        return {
            ok: false,
            message: `Unsupported model provider: ${input.providerId}.`,
        };
    }
    if (provider.id === 'bedrock') {
        if (input.authMode === 'aws_default_chain') {
            return verifyAwsDefaultChain(input.payload, input.timeoutMs ?? 10_000);
        }
        return {
            skipped: true,
            reason: 'Amazon Bedrock API key live credential verification is not supported without SigV4.',
        };
    }
    if (provider.id === 'vertex') {
        return verifyVertexCredential({
            authMode: input.authMode,
            payload: input.payload,
            timeoutMs: input.timeoutMs ?? 10_000,
        });
    }
    if (provider.id === 'anthropic' && input.authMode !== 'api_key') {
        return {
            skipped: true,
            reason: 'Anthropic Claude Code OAuth live credential verification is not supported yet.',
        };
    }
    const upstream = resolveGatewayUpstream(provider, input.authMode, input.payload);
    const upstreamUrl = credentialProbeUrl(provider.id, upstream);
    const headers = provider.id === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {};
    try {
        await injectProviderAuth({
            headers,
            provider,
            authMode: input.authMode,
            payload: input.payload,
            method: 'GET',
            upstreamUrl,
            body: Buffer.alloc(0),
        });
        const response = await fetch(upstreamUrl, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
        });
        if (response.ok)
            return { ok: true };
        const body = await readErrorSnippet(response);
        const message = `${provider.label} credential verification failed with HTTP ${response.status}${body ? `: ${body}` : '.'}`;
        return { ok: false, message };
    }
    catch (error) {
        return {
            ok: false,
            message: providerReachabilityMessage(provider.label, error),
        };
    }
}
async function verifyAwsDefaultChain(payload, timeoutMs) {
    try {
        const profile = payload.profile?.trim();
        const provider = fromNodeProviderChain(profile ? { profile } : {});
        const credentials = await withTimeout(provider(), timeoutMs);
        if (credentials.accessKeyId && credentials.secretAccessKey) {
            return {
                skipped: true,
                reason: 'AWS credentials resolved locally; not verified against Bedrock.',
            };
        }
    }
    catch {
        // Fall through to the stable user-facing message below.
    }
    return {
        ok: false,
        message: 'No AWS credentials resolved from the default chain. Configure AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE, or an AWS runtime role.',
    };
}
async function verifyVertexCredential(input) {
    if (input.authMode === 'service_account_ref') {
        try {
            const serviceAccountJson = await withTimeout(resolveModelCredentialSecretRef(input.payload.serviceAccountJsonRef), input.timeoutMs);
            return verifyGoogleToken({
                serviceAccountJson,
                timeoutMs: input.timeoutMs,
            });
        }
        catch {
            return {
                skipped: true,
                reason: 'Google Vertex AI service-account ref could not be resolved locally; not verified against Vertex.',
            };
        }
    }
    if (input.authMode === 'service_account') {
        return verifyGoogleToken({
            serviceAccountJson: input.payload.serviceAccountJson,
            projectId: input.payload.projectId,
            timeoutMs: input.timeoutMs,
        });
    }
    if (input.authMode === 'google_adc') {
        return verifyGoogleToken({ timeoutMs: input.timeoutMs, adc: true });
    }
    return {
        skipped: true,
        reason: 'Google Vertex AI live credential verification is not supported yet.',
    };
}
async function verifyGoogleToken(input) {
    try {
        // Reuse the runtime gateway's hardened token path — it pins token_uri to
        // the Google OAuth endpoint and copies only allowlisted credential fields,
        // so verification cannot leak a signed assertion to a rogue token_uri.
        if (input.serviceAccountJson) {
            await getVertexServiceAccountBearerToken({
                serviceAccountJson: input.serviceAccountJson,
                expectedProjectId: input.projectId?.trim() || '',
                tokenRequestTimeoutMs: input.timeoutMs,
            });
        }
        else {
            await getVertexAdcBearerToken({
                tokenRequestTimeoutMs: input.timeoutMs,
            });
        }
        return { ok: true };
    }
    catch (error) {
        if (isNetworkOrTimeoutError(error)) {
            return {
                ok: false,
                message: providerReachabilityMessage('Google Vertex AI', error),
            };
        }
        if (input.adc && isGoogleAdcMissing(error)) {
            return {
                ok: false,
                message: 'Google ADC is not configured. Run `gcloud auth application-default login`, then retry.',
            };
        }
        return {
            ok: false,
            message: `Google Vertex AI credential verification failed: ${errorSnippet(error)}`,
        };
    }
}
export async function inspectSlackTokenLiveCheck(input) {
    if (!input.settings.providers.slack?.enabled)
        return null;
    const [botToken, appToken] = await Promise.all([
        resolveProviderSecretForDoctor({
            providerId: 'slack',
            key: 'bot_token',
            defaultEnvName: 'SLACK_BOT_TOKEN',
            settings: input.settings,
            env: input.env,
        }),
        resolveProviderSecretForDoctor({
            providerId: 'slack',
            key: 'app_token',
            defaultEnvName: 'SLACK_APP_TOKEN',
            settings: input.settings,
            env: input.env,
        }),
    ]);
    if (botToken.token && appToken.token) {
        const [botValidation, appValidation] = await Promise.all([
            validateSlackBotToken(botToken.token, input.timeoutMs),
            validateSlackAppToken(appToken.token, input.timeoutMs),
        ]);
        if (botValidation.ok && appValidation.ok) {
            return {
                id: 'slack-token-api',
                title: 'Slack Token API Validation',
                status: 'pass',
                message: 'Slack bot/app tokens validated.',
            };
        }
        const failed = [botValidation, appValidation].filter((item) => !item.ok);
        const nextAction = SLACK_CHANNEL_TOKEN_NEXT_ACTION;
        return {
            id: 'slack-token-api',
            title: 'Slack Token API Validation',
            status: 'warn',
            message: failed.map((item) => item.message).join(' '),
            nextAction,
            action: { type: 'connect_provider', label: nextAction },
        };
    }
    if (!botToken.unresolvedStoredRef && !appToken.unresolvedStoredRef) {
        return null;
    }
    const nextAction = SLACK_CHANNEL_TOKEN_NEXT_ACTION;
    return {
        id: 'slack-token-api',
        title: 'Slack Token API Validation',
        status: 'warn',
        message: 'Slack token references are configured but secret values could not be resolved.',
        nextAction,
        action: { type: 'connect_provider', label: nextAction },
    };
}
export async function inspectTelegramTokenLiveCheck(input) {
    if (!input.settings.providers.telegram?.enabled)
        return null;
    const token = await resolveTelegramTokenForDoctor(input);
    if (token.token) {
        const validation = await validateTelegramBotToken(token.token, input.timeoutMs);
        if (validation.ok) {
            return {
                id: 'telegram-token-api',
                title: 'Telegram Token API Validation',
                status: 'pass',
                message: validation.message,
            };
        }
        const nextAction = TELEGRAM_CHANNEL_TOKEN_NEXT_ACTION;
        return {
            id: 'telegram-token-api',
            title: 'Telegram Token API Validation',
            status: 'warn',
            message: validation.message,
            nextAction,
            action: { type: 'connect_provider', label: nextAction },
        };
    }
    if (!token.unresolvedStoredRef)
        return null;
    const nextAction = TELEGRAM_CHANNEL_TOKEN_NEXT_ACTION;
    return {
        id: 'telegram-token-api',
        title: 'Telegram Token API Validation',
        status: 'warn',
        message: 'Telegram token reference is configured but the secret value could not be resolved.',
        nextAction,
        action: { type: 'connect_provider', label: nextAction },
    };
}
function credentialProbeUrl(providerId, upstream) {
    if (providerId === 'anthropic')
        return new URL('/v1/models', upstream.origin);
    if (providerId === 'openrouter')
        return new URL('/api/v1/key', upstream.origin);
    // Providers with an empty chat prefix (openai, perplexity) still serve
    // their model list under /v1 — verified against the live APIs.
    const prefix = upstream.pathPrefix || '/v1';
    return new URL(`${normalizePrefix(prefix)}/models`, upstream.origin);
}
function normalizePrefix(prefix) {
    const value = prefix.trim().replace(/\/+$/, '');
    return value ? (value.startsWith('/') ? value : `/${value}`) : '';
}
async function readErrorSnippet(response) {
    try {
        // Upstream bodies are outside Gantry's trust boundary and may echo the
        // submitted key or account identifiers — redact secret-shaped tokens
        // before the message reaches CLI/doctor output.
        return redactCredentialSnippet(await response.text());
    }
    catch {
        return '';
    }
}
function providerReachabilityMessage(label, error) {
    return `${label} credential verification ${isTimeoutError(error) ? 'timed out and ' : ''}could not reach provider. Check network access and retry.`;
}
function errorSnippet(error) {
    const message = error instanceof Error ? error.message : String(error);
    return redactCredentialSnippet(message || 'Unknown error.');
}
function redactCredentialSnippet(value) {
    return value
        .replace(/\b(?:sk|xox[bap]|xapp|gtw|ghp|gsk)[-_][\w.-]+/gi, '[redacted]')
        .replace(/\bBearer\s+[\w.-]+/gi, 'Bearer [redacted]')
        .replace(/[\w-]{24,}/g, '[redacted]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
}
function isTimeoutError(error) {
    return error instanceof DOMException && error.name === 'TimeoutError';
}
function isNetworkOrTimeoutError(error) {
    if (isTimeoutError(error))
        return true;
    const code = error && typeof error === 'object' && 'code' in error
        ? String(error.code).toLowerCase()
        : '';
    const message = errorSnippet(error).toLowerCase();
    return ([
        'econnrefused',
        'econnreset',
        'enotfound',
        'eai_again',
        'enetunreach',
        'etimedout',
    ].includes(code) ||
        /network|socket|timed out|fetch failed|could not reach/.test(message));
}
function isGoogleAdcMissing(error) {
    const message = errorSnippet(error).toLowerCase();
    return (message.includes('could not load the default credentials') ||
        message.includes('unable to find credentials in current environment') ||
        message.includes('application default credentials'));
}
function withTimeout(promise, timeoutMs) {
    let timeout;
    const timer = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new DOMException('timed out', 'TimeoutError')), timeoutMs);
        timeout.unref?.();
    });
    return Promise.race([promise, timer]).finally(() => {
        if (timeout)
            clearTimeout(timeout);
    });
}
async function resolveProviderSecretForDoctor(input) {
    // Prefer an active account that actually carries the requested key —
    // a stale disabled account (e.g. an old slack_default) must not shadow
    // the live one in multi-account setups.
    const accounts = Object.entries(input.settings.providerAccounts ?? {});
    const accountEntry = accounts.find(([, account]) => account?.provider === input.providerId &&
        account.status !== 'disabled' &&
        Boolean(account.runtimeSecretRefs[input.key]?.trim())) ?? accounts.find(([, account]) => account?.provider === input.providerId);
    const providerAccountId = accountEntry?.[0];
    const ref = accountEntry?.[1]?.runtimeSecretRefs[input.key];
    if (!ref?.trim()) {
        return {
            token: resolveRuntimeEnvValue(input.env, input.defaultEnvName),
            unresolvedStoredRef: false,
        };
    }
    let parsed;
    try {
        parsed = parseRuntimeSecretRefString(normalizeRuntimeSecretRefString(ref));
    }
    catch {
        return { token: '', unresolvedStoredRef: true };
    }
    if (parsed.source === 'env') {
        return {
            token: resolveRuntimeEnvValue(input.env, parsed.name),
            unresolvedStoredRef: false,
        };
    }
    let storage;
    try {
        const { createStorageRuntime } = await import('../adapters/storage/postgres/factory.js');
        storage = createStorageRuntime();
        const token = await getProviderRuntimeSecret({
            providerId: input.providerId,
            providerAccountId,
            key: input.key,
            defaultEnvName: input.defaultEnvName,
            settings: input.settings,
            secrets: createRepositoryRuntimeSecretProvider({
                appId: 'default',
                repository: storage.repositories.capabilitySecrets,
            }),
        });
        return { token, unresolvedStoredRef: !token };
    }
    catch {
        return { token: '', unresolvedStoredRef: true };
    }
    finally {
        await storage?.runtimeEventNotifier?.close().catch(() => undefined);
        await storage?.service?.close().catch(() => undefined);
    }
}
