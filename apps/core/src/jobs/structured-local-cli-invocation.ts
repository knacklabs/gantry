import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { resolveAgentToolRuntimePolicy } from '../application/agents/agent-tool-runtime-rules.js';
import type { ToolCatalogRepository } from '../domain/ports/repositories.js';
import type { BashCommandLeaf } from '../shared/bash-command-parser.js';
import { parseBashCommand } from '../shared/bash-command-parser.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
import { bashScopeMatchesLeaf } from '../shared/tool-rule-matcher.js';
import type { RunnerSandboxProvider } from '../shared/runner-sandbox-provider.js';
import { sanitizeOutboundLlmText } from '../shared/sensitive-material.js';
import {
  CAPABILITY_RUN_MAX_ARGS,
  CAPABILITY_RUN_MAX_ARG_BYTES,
  CAPABILITY_RUN_MAX_TOTAL_ARG_BYTES,
  CAPABILITY_RUN_OUTPUT_MAX_BYTES,
} from '../shared/structured-local-cli.js';
import { resolveHomeRelativePaths } from '../runtime/agent-spawn-runtime-policy.js';
import {
  DEFAULT_ASYNC_COMMAND_TIMEOUT_MS,
  DEFAULT_ASYNC_RESOURCE_LIMITS,
  runSandboxedAsyncCommand,
} from './async-command-sandbox-runner.js';

export type StructuredLocalCliInvocationErrorCode =
  | 'invalid_args'
  | 'permission_denied'
  | 'executable_identity_mismatch';

export class StructuredLocalCliInvocationError extends Error {
  constructor(
    readonly code: StructuredLocalCliInvocationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StructuredLocalCliInvocationError';
  }
}

interface ResolvedLocalCliInvocation {
  capability: SemanticCapabilityDefinition;
  executable: string;
  argv: string[];
}

export async function runStructuredLocalCliCapability(input: {
  repository: ToolCatalogRepository;
  appId: string;
  agentId: string;
  personId?: string | null;
  capabilityId: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  runnerSandboxProvider: RunnerSandboxProvider;
  egressProxyUrl?: string;
  signal: AbortSignal;
  conversationId: string;
  threadId?: string;
  runId?: string;
  jobId?: string;
}): Promise<{ stdout: string; stderr: string }> {
  const invocation = await resolveGrantedLocalCliInvocation(input);
  const credentialReadPaths = resolveHomeRelativePaths(
    invocation.capability.protectedPaths ?? [],
    input.env,
  );
  try {
    const result = await runSandboxedAsyncCommand(input.runnerSandboxProvider, {
      structuredCommand: {
        executable: invocation.executable,
        args: invocation.argv,
      },
      cwd: input.cwd,
      env: input.env,
      timeoutMs: DEFAULT_ASYNC_COMMAND_TIMEOUT_MS,
      outputMaxBytes: CAPABILITY_RUN_OUTPUT_MAX_BYTES,
      protectedReadPaths: [],
      protectedWritePaths: credentialReadPaths,
      runtimeReadPaths: credentialReadPaths,
      allowedNetworkHosts: [...(invocation.capability.networkHosts ?? [])],
      egressProxyUrl: input.egressProxyUrl,
      resourceLimits: DEFAULT_ASYNC_RESOURCE_LIMITS,
      signal: input.signal,
      appId: input.appId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      threadId: input.threadId,
      parentRunId: input.runId,
      parentJobId: input.jobId,
    });
    return {
      stdout: sanitizeOutboundLlmText(result.outputSummary ?? '').text,
      stderr: sanitizeOutboundLlmText(result.errorSummary ?? '').text,
    };
  } catch (error) {
    throw new Error(
      sanitizeOutboundLlmText(
        error instanceof Error ? error.message : 'Capability execution failed.',
      ).text,
    );
  }
}

async function resolveGrantedLocalCliInvocation(input: {
  repository: ToolCatalogRepository;
  appId: string;
  agentId: string;
  personId?: string | null;
  capabilityId: string;
  args: string[];
}): Promise<ResolvedLocalCliInvocation> {
  validateStructuredArgs(input.args);
  const capabilityId = input.capabilityId.trim();
  const policy = await resolveAgentToolRuntimePolicy({
    repository: input.repository,
    appId: input.appId,
    agentId: input.agentId,
    personId: input.personId,
    errorSubject: 'Configured agent tool',
  });
  const capability = policy.semanticCapabilities.find(
    (candidate) => candidate.capabilityId === capabilityId,
  );
  if (!capability || capability.credentialSource !== 'local_cli') {
    throw new StructuredLocalCliInvocationError(
      'permission_denied',
      `Capability "${capabilityId}" is not granted for this invocation.`,
    );
  }

  for (const binding of capability.implementationBindings) {
    if (binding.kind !== 'local_cli') continue;
    const executable = binding.executablePath?.trim();
    if (!executable) continue;
    const leaf: BashCommandLeaf = {
      argv: [executable, ...input.args],
      commandText: '',
      redirects: [],
    };
    const reviewed = (binding.commandTemplates ?? []).some(
      (template) =>
        bashScopeMatchesLeaf(template, leaf) &&
        structuredFlagsAreReviewed(template, leaf.argv),
    );
    if (!reviewed) continue;
    await verifyExecutableIdentity(executable, binding.executableHash);
    return {
      capability,
      executable,
      argv: [...input.args],
    };
  }

  throw new StructuredLocalCliInvocationError(
    'invalid_args',
    `Arguments are outside the reviewed pattern for capability "${capabilityId}".`,
  );
}

function validateStructuredArgs(args: readonly string[]): void {
  if (args.length > CAPABILITY_RUN_MAX_ARGS) {
    throw invalidArgs(
      `args must contain at most ${CAPABILITY_RUN_MAX_ARGS} entries.`,
    );
  }
  let totalBytes = 0;
  for (const arg of args) {
    if (arg.includes('\0')) {
      throw invalidArgs('args cannot contain NUL bytes.');
    }
    const bytes = Buffer.byteLength(arg, 'utf8');
    if (bytes > CAPABILITY_RUN_MAX_ARG_BYTES) {
      throw invalidArgs(
        `each arg must be at most ${CAPABILITY_RUN_MAX_ARG_BYTES} UTF-8 bytes.`,
      );
    }
    totalBytes += bytes;
  }
  if (totalBytes > CAPABILITY_RUN_MAX_TOTAL_ARG_BYTES) {
    throw invalidArgs(
      `args must total at most ${CAPABILITY_RUN_MAX_TOTAL_ARG_BYTES} UTF-8 bytes.`,
    );
  }
}

function invalidArgs(message: string): StructuredLocalCliInvocationError {
  return new StructuredLocalCliInvocationError('invalid_args', message);
}

function structuredFlagsAreReviewed(
  template: string,
  argv: readonly string[],
): boolean {
  const parsed = parseBashCommand(template.trim());
  if (!parsed.ok || parsed.leaves.length !== 1) return false;
  const patterns = parsed.leaves[0]?.argv ?? [];
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index] as string;
    if (!value.startsWith('-')) continue;
    const pattern = patterns[index];
    if (!pattern?.startsWith('-') || !globMatches(pattern, value)) return false;
  }
  return true;
}

function globMatches(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[\\^$+?.()|[\]{}]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(value);
}

async function verifyExecutableIdentity(
  executable: string,
  expectedHash: string | undefined,
): Promise<void> {
  const normalizedExpected = expectedHash?.trim().toLowerCase() ?? '';
  if (!/^sha256:[a-f0-9]{64}$/.test(normalizedExpected)) {
    throw new StructuredLocalCliInvocationError(
      'executable_identity_mismatch',
      'Capability executable identity is not pinned to a valid SHA-256 hash.',
    );
  }
  let actualHash: string;
  try {
    await fs.promises.access(executable, fs.constants.X_OK);
    actualHash = await sha256File(executable);
  } catch {
    throw new StructuredLocalCliInvocationError(
      'executable_identity_mismatch',
      'Capability executable identity could not be verified.',
    );
  }
  if (`sha256:${actualHash}` !== normalizedExpected) {
    throw new StructuredLocalCliInvocationError(
      'executable_identity_mismatch',
      'Capability executable identity does not match the reviewed hash.',
    );
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
