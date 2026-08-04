import { evaluateAutonomousToolUse, normalizeRuntimeOwnedBashCommandForMatching, } from './tool-rule-matcher.js';
import { bashExecutableName, nonDurableBashLeafReason, normalizeBashLeafRuleContent, parseBashCommand, } from './bash-command-parser.js';
import { isDurableGantryMcpToolFullName } from './admin-mcp-tools.js';
import { isKnownProjectedBrowserMcpToolName, publicGantryToolNameForSdkTool, } from './agent-tool-references.js';
import { commandText, hasBashMutationVerb, hasBashRedirect, hasProtectedPathInGhTextPayloadCommand, inferBashMutationTargets, inferBashTarget, isProviderMcpMutationCommand, isSafeProtectedPathTextPayloadCommand, } from './tool-execution-bash-policy.js';
import { allProtectedPathMentions, firstProtectedPathMention, isMcpCapabilityPath, isProtectedCapabilityPathLike, isProviderSettingsPath, isRuntimeSettingsPath, isSkillCapabilityPath, protectedCapabilityPathMatch, } from './tool-execution-protected-paths.js';
import { containsGeneratedRuntimePath, isGeneratedRuntimeToolResultPath, } from './generated-runtime-paths.js';
import { resolveCapabilityRules } from './tool-execution-capability-resolution.js';
const CAPABILITY_REQUEST_TOOLS = new Set([
    'mcp__gantry__request_mcp_server',
    'mcp__gantry__request_skill_install',
    'mcp__gantry__request_skill_proposal',
    'mcp__gantry__request_skill_dependency_install',
    'mcp__gantry__request_access',
]);
const FILE_MUTATION_TOOLS = new Set('Write Edit MultiEdit NotebookEdit'.split(' '));
const READ_TOOLS = new Set(['Read', 'LS', 'Glob', 'Grep']);
export class ToolExecutionClassifier {
    classify(input) {
        const toolName = input.toolName.trim();
        const toolKind = classifyToolKind(toolName);
        const targetResource = inferTargetResource(toolName, input.toolInput);
        return {
            origin: input.origin,
            toolKind,
            toolName,
            input: input.toolInput,
            runContext: input.runContext ?? {},
            executionMode: input.executionMode ?? 'interactive',
            targetResource,
            mutationIntent: inferMutationIntent(toolName, input.toolInput),
            actionPreview: inferActionPreview(toolName, input.toolInput),
        };
    }
}
export function buildAgentToolExecutionRequest(classifier, toolName, toolInput, context) {
    return classifier.classify({
        origin: 'sdk',
        toolName,
        toolInput,
        executionMode: context.isScheduledJob ? 'autonomous' : 'interactive',
        runContext: {
            jobId: context.isScheduledJob ? context.jobId : undefined,
            threadId: context.threadId,
            conversationId: context.conversationId,
        },
    });
}
export class ToolExecutionPolicyService {
    evaluate(input) {
        const requestToolsHidden = input.capabilityRequestToolsHidden === true;
        const protectedDecision = evaluateProtectedCapabilityRequest(input.request, requestToolsHidden);
        if (protectedDecision)
            return protectedDecision;
        if (input.request.executionMode === 'autonomous') {
            const runtimeToolResultRead = evaluateGeneratedRuntimeToolResultRead(input.request);
            if (runtimeToolResultRead)
                return runtimeToolResultRead;
            const resolved = resolveCapabilityRules(input.autonomousAllowedToolRules ?? input.allowedToolRules ?? [], input.semanticCapabilityDefinitions);
            const toolPolicy = evaluateAutonomousToolUse({
                rules: resolved.rules,
                toolName: input.request.toolName,
                toolInput: input.request.input,
            });
            if (toolPolicy.allowed) {
                const capabilityId = resolved.capabilityByRule.get(toolPolicy.matchedRule ?? '');
                return decision(input.request, 'allow', {
                    reason: capabilityId
                        ? `Allowed by selected capability ${capabilityId}.`
                        : `Allowed by autonomous tool rule ${toolPolicy.matchedRule}.`,
                    matchedRule: toolPolicy.matchedRule,
                });
            }
            return decision(input.request, 'deny', {
                reason: autonomousDenyReason(input.request.toolName, toolPolicy.reason),
                recoveryAction: autonomousGrantRecovery(input.request, requestToolsHidden),
                closestRule: toolPolicy.closestRule,
            });
        }
        if (input.allowedToolRules?.length) {
            const resolved = resolveCapabilityRules(input.allowedToolRules, input.semanticCapabilityDefinitions);
            const toolPolicy = evaluateAutonomousToolUse({
                rules: resolved.rules,
                toolName: input.request.toolName,
                toolInput: input.request.input,
            });
            if (toolPolicy.allowed) {
                const capabilityId = resolved.capabilityByRule.get(toolPolicy.matchedRule ?? '');
                return decision(input.request, 'allow', {
                    reason: capabilityId
                        ? `Allowed by selected capability ${capabilityId}.`
                        : `Allowed by selected capability rule ${toolPolicy.matchedRule}.`,
                    matchedRule: toolPolicy.matchedRule,
                });
            }
            return decision(input.request, 'not_applicable', {
                reason: selectedCapabilityMissReason(toolPolicy.reason),
                closestRule: toolPolicy.closestRule,
            });
        }
        return decision(input.request, 'not_applicable', {
            reason: 'No canonical tool execution policy matched.',
        });
    }
}
export function evaluateProtectedCapabilityToolUse(toolName, input) {
    const request = new ToolExecutionClassifier().classify({
        origin: 'sdk',
        toolName,
        toolInput: input,
    });
    const decision = evaluateProtectedCapabilityRequest(request);
    if (!decision || decision.status !== 'deny')
        return null;
    return {
        reason: decision.reason,
        recoveryAction: decision.recoveryAction ?? protectedCapabilityRecovery(),
    };
}
function evaluateProtectedCapabilityRequest(request, requestToolsHidden = false) {
    if (CAPABILITY_REQUEST_TOOLS.has(request.toolName))
        return null;
    if (request.toolName === 'Config') {
        const setting = stringField(request.input, 'setting');
        if (setting &&
            /(^|\.)mcpServers($|\.)|(^|\.)permissions($|\.)|permissionMode/i.test(setting)) {
            return decision(request, 'deny', {
                reason: `Config setting "${setting}" changes capability or permission policy.`,
                recoveryAction: protectedCapabilityRecovery(requestToolsHidden),
            });
        }
        return null;
    }
    if (request.toolName === 'Bash') {
        const command = commandText(request.input);
        if (!command)
            return null;
        if (isProviderMcpMutationCommand(command)) {
            return decision(request, 'deny', {
                reason: 'Shell command attempts to change MCP capability configuration.',
                recoveryAction: protectedCapabilityRecovery(requestToolsHidden),
            });
        }
        if (hasProtectedPathInGhTextPayloadCommand(command)) {
            const mentionedPath = firstProtectedPathMention(command);
            return decision(request, 'deny', {
                reason: mentionedPath
                    ? `Shell command references protected capability target "${mentionedPath}".`
                    : 'Shell command references protected capability target through GitHub payload arguments.',
                recoveryAction: protectedCapabilityRecovery(requestToolsHidden),
            });
        }
        const safeTextPayloadCommand = isSafeProtectedPathTextPayloadCommand(command);
        const protectedPathMention = allProtectedPathMentions(command)[0];
        if (!safeTextPayloadCommand && protectedPathMention) {
            return decision(request, 'deny', {
                reason: `Shell command references protected capability target "${protectedPathMention}".`,
                recoveryAction: protectedCapabilityRecovery(requestToolsHidden),
            });
        }
        const mutatesTarget = hasBashMutationVerb(command) || hasBashRedirect(command);
        if (!mutatesTarget) {
            return null;
        }
        const mutationTarget = inferBashMutationTargets(command).find(isProtectedCapabilityPathLike) ??
            (request.targetResource &&
                isProtectedCapabilityPathLike(request.targetResource)
                ? request.targetResource
                : undefined);
        if (mutationTarget) {
            return decision(request, 'deny', {
                reason: `Shell command mutates protected capability target "${mutationTarget}".`,
                recoveryAction: protectedCapabilityRecovery(requestToolsHidden),
            });
        }
        return null;
    }
    if (!FILE_MUTATION_TOOLS.has(request.toolName))
        return null;
    if (!request.targetResource)
        return null;
    const protectedPath = protectedCapabilityPathMatch(request.targetResource);
    const protectedKind = protectedPath && protectedFilePathKind(protectedPath);
    if (protectedKind) {
        return decision(request, 'deny', {
            reason: `File path "${request.targetResource}" is ${protectedKind}.`,
            recoveryAction: protectedCapabilityRecovery(requestToolsHidden),
        });
    }
    return null;
}
function evaluateGeneratedRuntimeToolResultRead(request) {
    if (request.toolName !== 'Bash')
        return null;
    const command = commandText(request.input);
    if (!command)
        return null;
    const parsed = parseBashCommand(normalizeRuntimeOwnedBashCommandForMatching(command));
    if (!parsed.ok)
        return null;
    if (parsed.leaves.length === 0)
        return null;
    if (!parsed.leaves.every(isSafeGeneratedRuntimeToolResultRead))
        return null;
    return decision(request, 'allow', {
        reason: 'Allowed read-only inspection of Gantry-generated runtime tool result files.',
        matchedRule: 'runtime:generated-tool-results:read',
    });
}
function isSafeGeneratedRuntimeToolResultRead(leaf) {
    if (leaf.redirects.some((redirect) => redirect.destructive))
        return false;
    const executable = bashExecutableName(leaf.argv[0] ?? '');
    const fileArgs = generatedRuntimeToolResultReadFileArgs(executable, leaf.argv);
    return (fileArgs.length > 0 && fileArgs.every(isGeneratedRuntimeToolResultPath));
}
function generatedRuntimeToolResultReadFileArgs(executable, argv) {
    if (executable === 'cat')
        return readCommandArgsAfterOptions(argv.slice(1));
    if (executable === 'head' || executable === 'tail') {
        return headTailFileArgs(argv.slice(1));
    }
    return [];
}
function headTailFileArgs(args) {
    const out = [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index] ?? '';
        if (!arg)
            continue;
        if (/^-\d+$/.test(arg))
            continue;
        if (arg === '-n' ||
            arg === '--lines' ||
            arg === '-c' ||
            arg === '--bytes') {
            index += 1;
            continue;
        }
        if (arg.startsWith('-n') || arg.startsWith('-c'))
            continue;
        if (arg.startsWith('--lines=') || arg.startsWith('--bytes='))
            continue;
        if (arg.startsWith('-'))
            return [];
        out.push(arg);
    }
    return out;
}
function readCommandArgsAfterOptions(args) {
    const out = [];
    let afterOptionTerminator = false;
    for (const arg of args) {
        if (!arg)
            continue;
        if (!afterOptionTerminator && arg === '--') {
            afterOptionTerminator = true;
            continue;
        }
        if (!afterOptionTerminator && arg.startsWith('-'))
            continue;
        out.push(arg);
    }
    return out;
}
function protectedFilePathKind(protectedPath) {
    if (isSkillCapabilityPath(protectedPath))
        return 'a skill capability path';
    if (isMcpCapabilityPath(protectedPath))
        return 'an MCP capability configuration path';
    if (isProviderSettingsPath(protectedPath))
        return 'a provider settings capability path';
    if (isRuntimeSettingsPath(protectedPath))
        return 'a runtime settings capability path';
    return undefined;
}
function decision(request, status, options) {
    return {
        status,
        reason: options.reason,
        audit: {
            category: 'tool_execution',
            origin: request.origin,
            toolKind: request.toolKind,
            toolName: request.toolName,
            mutationIntent: request.mutationIntent,
            ...(request.targetResource
                ? { targetResource: request.targetResource }
                : {}),
            ...(request.runContext.runId ? { runId: request.runContext.runId } : {}),
            ...(request.runContext.jobId ? { jobId: request.runContext.jobId } : {}),
        },
        ...(options.recoveryAction
            ? { recoveryAction: options.recoveryAction }
            : {}),
        ...(options.matchedRule ? { matchedRule: options.matchedRule } : {}),
        ...(options.closestRule ? { closestRule: options.closestRule } : {}),
    };
}
function autonomousDenyReason(toolName, mismatchReason) {
    const publicToolName = publicGantryToolNameForSdkTool(toolName);
    const prefix = `Tool not on autonomous run allowlist: ${publicToolName}.`;
    return mismatchReason ? `${prefix} ${mismatchReason}` : prefix;
}
function selectedCapabilityMissReason(mismatchReason) {
    return mismatchReason
        ? `No canonical tool execution policy matched. ${mismatchReason}`
        : 'No canonical tool execution policy matched.';
}
function classifyToolKind(toolName) {
    if (toolName === 'Bash')
        return 'bash';
    if (toolName === 'Config')
        return 'config';
    if (FILE_MUTATION_TOOLS.has(toolName) || READ_TOOLS.has(toolName))
        return 'file';
    if (toolName.startsWith('mcp__gantry__browser_')) {
        return 'browser';
    }
    if (toolName.startsWith('mcp__'))
        return 'mcp';
    return toolName ? 'sdk' : 'unknown';
}
function inferMutationIntent(toolName, input) {
    if (toolName === 'Config')
        return 'configure';
    if (toolName === 'Bash') {
        const command = commandText(input);
        if (!command)
            return 'execute';
        if (/\brm\s+/.test(command))
            return 'delete';
        if (isProviderMcpMutationCommand(command))
            return 'configure';
        if (hasBashMutationVerb(command) || hasBashRedirect(command))
            return 'write';
        return 'execute';
    }
    if (READ_TOOLS.has(toolName))
        return 'read';
    if (FILE_MUTATION_TOOLS.has(toolName))
        return 'write';
    return 'unknown';
}
function inferTargetResource(toolName, input) {
    if (toolName === 'Bash') {
        const command = commandText(input);
        return command ? inferBashTarget(command) : undefined;
    }
    return (stringField(input, 'file_path') ??
        stringField(input, 'filePath') ??
        stringField(input, 'path') ??
        stringField(input, 'notebook_path') ??
        stringField(input, 'notebookPath') ??
        stringField(input, 'url'));
}
function inferActionPreview(toolName, input) {
    if (toolName === 'Bash')
        return commandText(input);
    return undefined;
}
function stringField(input, field) {
    if (!input || typeof input !== 'object')
        return undefined;
    const value = input[field];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
// Mode-aware recovery phrasing: locked-preset and fixed-image agents have the
// capability request tools hidden, so guidance must never instruct calling
// one; it says to provision the reviewed capability before the run instead.
const HIDDEN_REQUEST_TOOLS_RECOVERY_PREFIX = 'Capability request tools are not available in this run (locked or fixed-image agent).';
function protectedCapabilityRecovery(requestToolsHidden = false) {
    if (requestToolsHidden) {
        return `${HIDDEN_REQUEST_TOOLS_RECOVERY_PREFIX} Ask an operator to provision the reviewed change before the run.`;
    }
    return 'Use request_skill_install, request_skill_proposal, request_skill_dependency_install, request_mcp_server, or request_access so the change is reviewed, stored durably, and activated through Gantry access flows.';
}
function autonomousGrantRecovery(request, requestToolsHidden = false) {
    if (requestToolsHidden) {
        return `${HIDDEN_REQUEST_TOOLS_RECOVERY_PREFIX} Ask an operator to provision a reviewed capability covering ${publicGantryToolNameForSdkTool(request.toolName)} before the run.`;
    }
    if (isKnownProjectedBrowserMcpToolName(request.toolName)) {
        return 'request_access { "target": { "kind": "capability", "id": "browser.use" }, "temporaryOnly": false, "reason": "This autonomous run needs browser access." }';
    }
    if (request.toolName === 'Bash') {
        const command = commandText(request.input);
        const rule = command ? persistentBashRecoveryRule(command) : undefined;
        if (!rule) {
            return 'Update the autonomous run to use a reviewed semantic capability or invoke a scoped RunCommand(...) command directly. This command cannot be durably approved for autonomous runs.';
        }
        return `request_access { "target": { "kind": "run_command", "argvPattern": "${escapeJson(rule)}" }, "temporaryOnly": false, "reason": "This autonomous run needs scoped command access." }`;
    }
    if (isDurableGantryMcpToolFullName(request.toolName)) {
        return `request_access { "target": { "kind": "tool", "name": "${escapeJson(request.toolName)}" }, "temporaryOnly": false, "reason": "This autonomous run needs exact Gantry tool access." }`;
    }
    const thirdPartyMcp = thirdPartyMcpToolServerName(request.toolName);
    if (thirdPartyMcp) {
        return `request_mcp_server { "name": "${escapeJson(thirdPartyMcp)}", "transport": "stdio_template", "templateId": "npx-package", "args": ["<reviewed-package>"], "sandboxProfileId": "mcp-stdio", "reason": "This autonomous run needs the ${escapeJson(thirdPartyMcp)} MCP source connected before reviewed action capabilities can be requested." }`;
    }
    const toolName = publicGantryToolNameForSdkTool(request.toolName);
    return `Use a reviewed semantic capability from the Agent Access summary for ${escapeJson(toolName)}, or use request_access target.kind=run_command only for a scoped command fallback. Exact tool grants are not accepted as durable authority.`;
}
function thirdPartyMcpToolServerName(toolName) {
    const match = /^mcp__([^_][A-Za-z0-9_.-]*)__/.exec(toolName);
    const serverName = match?.[1];
    if (!serverName || serverName === 'gantry')
        return undefined;
    return serverName;
}
function escapeJson(value) {
    return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
function persistentBashRecoveryRule(command) {
    const normalized = normalizeRuntimeOwnedBashCommandForMatching(command);
    if (containsGeneratedRuntimePath(normalized))
        return undefined;
    const parsed = parseBashCommand(normalized);
    if (!parsed.ok || parsed.leaves.length !== 1)
        return undefined;
    const [leaf] = parsed.leaves;
    if (!leaf || nonDurableBashLeafReason(leaf))
        return undefined;
    if (inlineInterpreterLeaf(leaf.argv))
        return undefined;
    if (leaf.redirects.some((redirect) => redirect.destructive))
        return undefined;
    return normalizeBashLeafRuleContent(leaf);
}
function inlineInterpreterLeaf(argv) {
    const executable = bashExecutableName(argv[0] ?? '');
    if (!['node', 'python', 'python3', 'ruby', 'perl', 'php'].includes(executable))
        return false;
    return ['-c', '-e'].includes(argv[1] ?? '');
}
