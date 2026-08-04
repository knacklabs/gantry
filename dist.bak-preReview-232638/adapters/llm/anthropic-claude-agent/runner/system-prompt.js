import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import { buildGantryAgentSystemPrompt, } from '../../../../runner/gantry-agent-system-prompt.js';
import { log } from './logging.js';
export function buildSystemPrompt(input) {
    return promptParts(buildGantryAgentSystemPrompt({
        runtimeProjection: 'native-tool-projection',
        promptMode: 'minimal',
        assistantName: input?.assistantName,
        persona: input?.persona,
        compiledSystemPrompt: input?.compiledSystemPrompt,
        currentDateTimeIso: new Date().toISOString(),
    }));
}
export function readMemoryContextBlock(agentInput) {
    try {
        return typeof agentInput.memoryContextBlock === 'string'
            ? agentInput.memoryContextBlock.trim()
            : '';
    }
    catch (err) {
        log(`Failed to load memory context block: ${err instanceof Error ? err.message : String(err)}`);
        return '';
    }
}
export function buildRunnerSystemPrompt(agentInput, memoryBlock) {
    return promptParts(buildGantryAgentSystemPrompt({
        runtimeProjection: 'native-tool-projection',
        promptMode: agentInput.promptMode,
        assistantName: agentInput.assistantName,
        persona: agentInput.persona,
        compiledSystemPrompt: agentInput.compiledSystemPrompt,
        hasMemoryContext: Boolean(memoryBlock),
        selectedToolRules: agentInput.allowedTools,
        workspaceFolder: agentInput.workspaceFolder,
        conversationId: agentInput.chatJid,
        threadId: agentInput.threadId,
        isScheduledJob: agentInput.isScheduledJob,
        currentDateTimeIso: new Date().toISOString(),
    }));
}
function promptParts(prompt) {
    return prompt.dynamicPrompt
        ? [
            prompt.staticPrompt,
            SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
            prompt.dynamicPrompt,
        ]
        : [prompt.staticPrompt];
}
