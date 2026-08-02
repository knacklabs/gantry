import fs from 'node:fs';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { tool } from '@langchain/core/tools';
import { buildGantryMcpProjection } from './gantry-mcp-env.js';
import { canonicalThirdPartyMcpToolName, wrapThirdPartyMcpToolsWithGate, } from './third-party-mcp-gate.js';
import { createGantryShellTool, GANTRY_SHELL_TOOL_NAME, SHELL_POLICY_TOOL_NAME, } from './gantry-shell-tool.js';
import { createGantryFacadeTools, DEEPAGENTS_GANTRY_FACADE_TOOL_NAMES, gantryFacadePolicyToolRequest, } from './gantry-facade-tools.js';
import { isHostPrivateBrowserMcpServerName } from '../../../../shared/agent-tool-references.js';
import { canonicalGantryToolRuleName, isRunCommandToolRule, } from '../../../../shared/gantry-tool-facades.js';
import { evaluateDeclarativeToolRules, } from '../../../../runner/tool-gate-core.js';
import { CALLABLE_AGENT_SYNC_WAIT_MAX_MS, callableAgentToolName, } from '../../../../application/core-tools/callable-agent-tools.js';
// Connects the DeepAgents runner to Gantry-owned MCP authority and converts it
// to LangChain tools. DeepAgents has no autonomous MCP — we fully control the
// `tools` list — so this module is the only place MCP tools enter the graph.
//
//   - The Gantry facade server (apps/core/src/runner/mcp/stdio.js) is spawned
//     here as a stdio MCP server with the projected GANTRY_* env block; its
//     tools are filtered to the host-selected name set (browser_* only when the
//     host enabled browser IPC).
//   - Third-party MCP servers are not connected directly in this runner. Any
//     external server config in GANTRY_MCP_CONFIG_FILE is rejected before
//     MultiServerMCPClient is constructed until Gantry owns a DNS-pinned
//     dispatcher/proxy path.
//
// We set prefixToolNameWithServerName=false and additionalToolNamePrefix='' so a
// LangChain tool's `.name` equals the raw MCP tool name (send_message,
// browser_open, ...), which is what the host selection set and tool-policy rules
// reference. throwOnLoadError=true fails the run loudly if a required server
// cannot connect rather than silently dropping authority.
const GANTRY_SERVER_NAME = 'gantry';
const CALLABLE_AGENT_MCP_TOOL_TIMEOUT_MS = CALLABLE_AGENT_SYNC_WAIT_MAX_MS + 20_000;
export async function connectGantryAndThirdPartyMcpTools(input) {
    const mcpServerPath = process.env.GANTRY_MCP_SERVER_PATH?.trim();
    if (!mcpServerPath) {
        throw new Error('DeepAgents runner is missing GANTRY_MCP_SERVER_PATH for the Gantry facade MCP server.');
    }
    const projection = buildGantryMcpProjection({
        configuredAllowedTools: input.configuredAllowedTools,
        hideAuthorityTools: input.hideAuthorityTools,
        memoryBlock: input.gate.memoryBlock,
        processEnv: process.env,
        callableAgentManifest: input.callableAgentManifest,
    });
    const externalServers = readExternalMcpServers();
    const mcpServers = {
        [GANTRY_SERVER_NAME]: {
            transport: 'stdio',
            command: 'node',
            args: [mcpServerPath],
            env: projection.env,
            stderr: 'inherit',
        },
    };
    for (const [name, config] of Object.entries(externalServers)) {
        mcpServers[name] = toMultiServerConnection(config);
    }
    const client = new MultiServerMCPClient({
        mcpServers: mcpServers,
        throwOnLoadError: true,
        prefixToolNameWithServerName: false,
        additionalToolNamePrefix: '',
        useStandardContentBlocks: true,
    });
    let serverTools;
    try {
        serverTools = (await client.initializeConnections());
    }
    catch (err) {
        await client.close().catch(() => { });
        throw err;
    }
    const selectedGantrySet = new Set(projection.selectedToolNames);
    const callableAgentToolNames = new Set((input.callableAgentManifest ?? []).map(callableAgentToolName));
    const gantryTools = (serverTools[GANTRY_SERVER_NAME] ?? [])
        .filter((tool) => selectedGantrySet.has(tool.name))
        .map((tool) => callableAgentToolNames.has(tool.name)
        ? withCallableAgentTimeout(tool)
        : tool);
    const delegateTaskTool = gantryTools.find((tool) => tool.name === 'delegate_task');
    const facadeTools = createGantryFacadeTools({
        workspaceFolder: input.gate.workspaceFolder,
        memoryBlock: input.gate.memoryBlock,
        configuredAllowedTools: input.configuredAllowedTools,
        toolNetworkEnv: input.toolNetworkEnv,
        gateContext: input.gate.gateContext,
        permissionEnv: input.gate.permissionEnv,
        lockedAccessPreset: input.gate.lockedAccessPreset,
        asyncTaskToolsEnabled: projection.asyncTaskToolsEnabled,
        delegateTaskTool,
        filesystemToolsEnabled: shouldProjectGantryFilesystemTools({
            filesystemEnabledEnv: process.env.GANTRY_DEEPAGENTS_FILESYSTEM_ENABLED,
        }),
        ...(input.shellCwd ? { cwd: input.shellCwd } : {}),
        ...(input.gate.signal ? { signal: input.gate.signal } : {}),
    });
    const reservedToolNames = new Set([
        ...selectedGantrySet,
        ...DEEPAGENTS_GANTRY_FACADE_TOOL_NAMES,
    ]);
    const thirdPartyToolEntries = [];
    for (const [name, tools] of Object.entries(serverTools)) {
        if (name === GANTRY_SERVER_NAME)
            continue;
        const gated = wrapThirdPartyMcpToolsWithGate(dropCollidingThirdPartyTools(name, tools, reservedToolNames), name, {
            ...input.gate,
            configuredAllowedTools: input.configuredAllowedTools,
        });
        thirdPartyToolEntries.push(...gated.map((tool) => ({
            tool,
            canonicalName: () => canonicalThirdPartyMcpToolName(name, tool.name),
        })));
    }
    const shellTools = projectGantryShellTool(input);
    const toolEntries = [
        ...gantryTools.map((tool) => ({
            tool,
            canonicalName: () => canonicalGantryToolRuleName(tool.name, {
                callableAgentToolNames,
            }),
        })),
        ...facadeTools.map((tool) => ({
            tool,
            canonicalName: (toolInput) => gantryFacadePolicyToolRequest(tool.name, toolInput).toolName,
        })),
        ...thirdPartyToolEntries,
        ...shellTools.map((tool) => ({
            tool,
            canonicalName: () => SHELL_POLICY_TOOL_NAME,
        })),
    ];
    return {
        tools: wrapWithDeclarativeToolRules(toolEntries, input.toolRules, input.toolSuccessLedger, input.onToolRuleDenial),
        close: () => client.close(),
    };
}
function withCallableAgentTimeout(underlying) {
    const invoke = underlying.invoke.bind(underlying);
    underlying.invoke = ((toolInput, config) => invoke(toolInput, {
        ...config,
        timeout: CALLABLE_AGENT_MCP_TOOL_TIMEOUT_MS,
    }));
    return underlying;
}
function wrapWithDeclarativeToolRules(entries, rules, successLedger, onDenial) {
    if (!rules?.length)
        return entries.map(({ tool }) => tool);
    return entries.map(({ tool: underlying, canonicalName }) => tool(async (input, config) => {
        const toolName = canonicalName(input);
        const denial = evaluateDeclarativeToolRules({
            toolName,
            toolInput: input,
            rules,
            successLedger,
        });
        if (denial) {
            onDenial?.(toolName, denial);
            return {
                content: [{ type: 'text', text: denial.error.message }],
                isError: true,
                error: denial.error,
            };
        }
        const innerConfig = { ...config };
        delete innerConfig.toolCall;
        const result = await underlying.invoke(input, innerConfig);
        if (!toolResultIsError(result)) {
            successLedger?.recordSuccess(toolName);
        }
        return result;
    }, {
        name: underlying.name,
        description: underlying.description,
        schema: underlying.schema,
    }));
}
function toolResultIsError(result) {
    if (Array.isArray(result))
        return result.some(toolResultIsError);
    if (!result || typeof result !== 'object')
        return false;
    const value = result;
    return (value.isError === true ||
        value.status === 'error' ||
        Boolean(value.error) ||
        toolResultIsError(value.content));
}
// A third-party server must not be able to shadow a Gantry authority tool
// (selectedGantrySet) or the reserved shell tool name: a duplicate name in the
// final list would let a model calling e.g. send_message reach the third-party
// tool instead. Drop colliding tools (never throw — one bad server must not kill
// the run) and warn the operator with the offending server+tool. Exported for
// unit coverage.
export function dropCollidingThirdPartyTools(serverName, tools, selectedGantrySet) {
    const kept = [];
    for (const tool of tools) {
        if (selectedGantrySet.has(tool.name) ||
            tool.name === GANTRY_SHELL_TOOL_NAME) {
            console.warn(`[deepagents-mcp] Dropping third-party MCP tool "${tool.name}" from server "${serverName}": it collides with a reserved Gantry tool name.`);
            continue;
        }
        kept.push(tool);
    }
    return kept;
}
// Whether the Gantry-owned, policy-gated shell tool should be injected into the
// graph for this run. Both conditions must hold:
//   (a) the host enabled it via GANTRY_DEEPAGENTS_SHELL_ENABLED='1' — derived on
//       the host from the SAME guard inputs (engine deepagents + RunCommand rule
//       + enforcing sandbox_runtime); the host fails the spawn closed otherwise, AND
//   (b) a resolved tool rule actually grants RunCommand/shell authority.
// A missing/absent host flag OR no RunCommand rule means no shell tool — behavior
// is exactly as before, and the model has no execution surface at all (StateBackend
// + DENY_ALL_FILESYSTEM leave deepagents with no `execute`). Exported for unit
// coverage of the two-condition gate.
export function shouldProjectGantryShellTool(input) {
    if (input.shellEnabledEnv !== '1')
        return false;
    return input.configuredAllowedTools.some((rule) => isRunCommandToolRule(rule));
}
export function shouldProjectGantryFilesystemTools(input) {
    return input.filesystemEnabledEnv === '1';
}
function projectGantryShellTool(input) {
    if (!shouldProjectGantryShellTool({
        shellEnabledEnv: process.env.GANTRY_DEEPAGENTS_SHELL_ENABLED,
        configuredAllowedTools: input.configuredAllowedTools,
    })) {
        return [];
    }
    return [
        createGantryShellTool({
            workspaceFolder: input.gate.workspaceFolder,
            memoryBlock: input.gate.memoryBlock,
            configuredAllowedTools: input.configuredAllowedTools,
            gateContext: input.gate.gateContext,
            permissionEnv: input.gate.permissionEnv,
            lockedAccessPreset: input.gate.lockedAccessPreset,
            toolNetworkEnv: input.toolNetworkEnv,
            ...(input.shellCwd ? { cwd: input.shellCwd } : {}),
            ...(input.shellSignal ? { signal: input.shellSignal } : {}),
        }),
    ];
}
function readExternalMcpServers() {
    const configPath = process.env.GANTRY_MCP_CONFIG_FILE?.trim();
    if (!configPath)
        return {};
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const servers = {};
    for (const [name, config] of Object.entries(parsed)) {
        if (name === GANTRY_SERVER_NAME) {
            throw new Error('Configured MCP servers cannot override the built-in gantry server');
        }
        if (isHostPrivateBrowserMcpServerName(name)) {
            throw new Error('Host-private browser MCP servers are not configurable. Use the canonical Browser capability and Gantry-owned browser gateway tools.');
        }
        rejectExternalThirdPartyMcpServer(name, config);
        servers[name] = config;
    }
    return servers;
}
export function rejectExternalThirdPartyMcpServer(name, config) {
    if (!config || typeof config !== 'object') {
        throw new Error(`DeepAgents direct third-party MCP config is disabled for external server "${name}" (invalid) until Gantry owns a DNS-pinned MCP dispatcher.`);
    }
    let transport = config.type ?? config.transport ?? 'unknown';
    if (transport === 'unknown' && typeof config.command === 'string') {
        transport = 'stdio';
    }
    if (transport === 'unknown' && typeof config.url === 'string') {
        transport = 'remote';
    }
    throw new Error(`DeepAgents direct third-party MCP config is disabled for external server "${name}" (${transport}) until Gantry owns a DNS-pinned MCP dispatcher.`);
}
function toMultiServerConnection(config) {
    if (config.type === 'http' || config.type === 'sse') {
        if (!config.url) {
            throw new Error('Configured remote MCP server is missing a url.');
        }
        return {
            transport: config.type === 'sse' ? 'sse' : 'http',
            url: config.url,
            ...(config.headers ? { headers: config.headers } : {}),
        };
    }
    if (!config.command) {
        throw new Error('Configured stdio MCP server is missing a command.');
    }
    return {
        transport: 'stdio',
        command: config.command,
        args: config.args ?? [],
        ...(config.env ? { env: config.env } : {}),
        stderr: 'inherit',
    };
}
