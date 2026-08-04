import { query, } from '@anthropic-ai/claude-agent-sdk';
import { SDK_NATIVE_SKILL_DISABLE_ENV, SDK_NATIVE_SKILL_OVERRIDES, } from '../native-sdk-skills.js';
import { buildSystemPrompt } from './system-prompt.js';
import { log } from './logging.js';
import { writeOutput } from './output.js';
import { allowedOuterSandboxClaudeExecutable, resolveClaudeCodeExecutableFromPath, WORKSPACE_GROUP_DIR, } from './runtime-env.js';
export function parseSessionSlashCommand(prompt) {
    const trimmed = prompt.trim();
    if (/^\/model(?:\s+\S+)?$/.test(trimmed)) {
        return { command: trimmed, kind: 'model' };
    }
    return null;
}
export async function runSessionSlashCommand(opts) {
    log(`Handling session command: ${opts.command}${opts.silent ? ' (silent)' : ''}`);
    let slashSessionId;
    let hadError = false;
    let resultEmitted = false;
    let errorMessage;
    const systemPrompt = buildSystemPrompt({
        assistantName: opts.assistantName,
        persona: opts.persona,
        compiledSystemPrompt: opts.systemPromptAppend,
    });
    const isolatedSdkEnv = {
        ...opts.sdkEnv,
        ...SDK_NATIVE_SKILL_DISABLE_ENV,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    };
    const claudeCodeExecutable = process.env.GANTRY_SANDBOX_RUNTIME_PROXY === '1'
        ? allowedOuterSandboxClaudeExecutable(resolveClaudeCodeExecutableFromPath(isolatedSdkEnv.PATH))
        : undefined;
    try {
        for await (const message of query({
            prompt: opts.command,
            options: {
                model: opts.configuredModel,
                thinking: opts.configuredThinking,
                effort: opts.configuredEffort,
                cwd: WORKSPACE_GROUP_DIR,
                persistSession: false,
                systemPrompt,
                settings: {
                    autoMemoryEnabled: false,
                    includeGitInstructions: false,
                    skillOverrides: SDK_NATIVE_SKILL_OVERRIDES,
                },
                skills: [],
                allowedTools: [],
                env: isolatedSdkEnv,
                ...(claudeCodeExecutable
                    ? { pathToClaudeCodeExecutable: claudeCodeExecutable }
                    : {}),
                permissionMode: 'default',
                canUseTool: async () => ({
                    behavior: 'deny',
                    message: 'Session slash commands cannot use tools.',
                }),
                settingSources: [],
                strictMcpConfig: true,
            },
        })) {
            const msgType = message.type === 'system'
                ? `system/${message.subtype}`
                : message.type;
            log(`[slash-cmd] type=${msgType}`);
            if (message.type === 'system' && message.subtype === 'init') {
                slashSessionId = message.session_id;
                log(`Session after slash command: ${slashSessionId}`);
            }
            if (message.type === 'result') {
                const resultSubtype = message.subtype;
                const textResult = 'result' in message ? message.result : null;
                const resultIsError = Boolean(resultSubtype?.startsWith('error'));
                if (resultIsError) {
                    hadError = true;
                    errorMessage = textResult || 'Session command failed.';
                    if (!opts.silent) {
                        writeOutput({
                            status: 'error',
                            result: null,
                            error: errorMessage,
                            newSessionId: slashSessionId,
                        });
                    }
                }
                else if (!opts.silent) {
                    writeOutput({
                        status: 'success',
                        result: textResult || null,
                        newSessionId: slashSessionId,
                    });
                }
                resultEmitted = true;
            }
        }
    }
    catch (err) {
        hadError = true;
        errorMessage = err instanceof Error ? err.message : String(err);
        log(`Slash command error: ${errorMessage}`);
        if (!opts.silent) {
            writeOutput({
                status: 'error',
                result: null,
                error: errorMessage,
                newSessionId: slashSessionId,
            });
        }
    }
    log(`Slash command done. hadError=${hadError}, resultEmitted=${resultEmitted}`);
    if (!opts.silent) {
        if (!hadError) {
            writeOutput({
                status: 'success',
                result: null,
                newSessionId: slashSessionId,
            });
        }
    }
    return {
        status: hadError ? 'error' : 'success',
        newSessionId: slashSessionId,
        hadError,
        resultEmitted,
        error: errorMessage,
    };
}
