import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveAgentToolRuntimePolicy } from '../application/agents/agent-tool-runtime-rules.js';
import type { ToolCatalogRepository } from '../domain/ports/repositories.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
import type { RunnerSandboxProvider } from '../shared/runner-sandbox-provider.js';
import { sanitizeOutboundLlmText } from '../shared/sensitive-material.js';
import {
  CAPABILITY_RUN_MAX_ARGS,
  CAPABILITY_RUN_MAX_ARG_BYTES,
  CAPABILITY_RUN_MAX_TOTAL_ARG_BYTES,
  CAPABILITY_RUN_OUTPUT_MAX_BYTES,
} from '../shared/structured-local-cli.js';
import { localCliCommandTemplateMatchesArgv } from '../shared/tool-rule-matcher.js';
import { resolveHomeRelativePaths } from '../runtime/agent-spawn-runtime-policy.js';
import {
  DEFAULT_ASYNC_COMMAND_TIMEOUT_MS,
  DEFAULT_ASYNC_RESOURCE_LIMITS,
  runSandboxedAsyncCommand,
} from './async-command-sandbox-runner.js';

export type StructuredLocalCliInvocationErrorCode =
  | 'invalid_args'
  | 'capability_template_mismatch'
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
  // Refuse to launch if the deadline already elapsed during setup (gateway,
  // policy resolution, executable verification): a command must never START
  // after the MCP caller has already been told it timed out.
  input.signal.throwIfAborted();
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
    if (error instanceof StructuredLocalCliInvocationError) throw error;
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
  cwd: string;
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
    const argv = [executable, ...input.args];
    const reviewed = (binding.commandTemplates ?? []).some((template) =>
      localCliCommandTemplateMatchesArgv({
        executablePath: executable,
        template,
        argv,
      }),
    );
    if (!reviewed) continue;
    const verifiedExecutable = await verifyImmutableExecutable(
      executable,
      binding.executableHash,
      input.cwd,
    );
    return {
      capability,
      executable: verifiedExecutable,
      argv: [...input.args],
    };
  }

  // Teach the shape IN THE TOOL'S OWN VOCABULARY: args arrays without the
  // executable, so there is nothing shell-shaped to copy into Bash (a full
  // template string got pasted into a shell on the first live run). The
  // templates are not secret - they appear verbatim on approval cards -
  // and the runtime, not the job prompt, owns call-shape recovery.
  const reviewedArgPatterns = capability.implementationBindings
    .filter((binding) => binding.kind === 'local_cli')
    .flatMap((binding) =>
      (binding.commandTemplates ?? []).map((template) => {
        const executable = binding.executablePath?.trim() ?? '';
        const rest = template.startsWith(executable)
          ? template.slice(executable.length).trim()
          : template.trim();
        return JSON.stringify(rest.split(/\s+/));
      }),
    );
  throw new StructuredLocalCliInvocationError(
    'capability_template_mismatch',
    `Arguments are outside the reviewed pattern for capability "${capabilityId}". Reviewed args patterns: ${reviewedArgPatterns.join(' or ')}. Re-call capability_run with an args array matching one pattern (a terminal standalone "*" covers the remaining args; a non-terminal "*" covers one non-flag positional value). Never run this capability through Bash/RunCommand.`,
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

// Bind execution to the verified bytes, TOCTOU-safe, WITHOUT relocating the
// executable (relocating breaks launchers/native binaries that resolve adjacent
// files or libraries relative to their own path). Instead we resolve the real
// path (following symlinks) and prove it cannot be swapped between verify and
// spawn: it must live OUTSIDE the agent-writable workspace and must not be
// group/other-writable. A file the agent cannot write cannot be replaced under
// it, so hashing and spawning that same real path is safe. Returns the resolved
// path to run in place.
async function verifyImmutableExecutable(
  executable: string,
  expectedHash: string | undefined,
  agentWritableRoot: string,
): Promise<string> {
  const normalizedExpected = expectedHash?.trim().toLowerCase() ?? '';
  if (!/^sha256:[a-f0-9]{64}$/.test(normalizedExpected)) {
    throw new StructuredLocalCliInvocationError(
      'executable_identity_mismatch',
      'Capability executable identity is not pinned to a valid SHA-256 hash.',
    );
  }
  // ponytail: baseline identity binding, sufficient against the AGENT (which
  // cannot write to the workspace-excluded system paths where capability
  // executables live). Deferred deep hardening (D-0056): walking the full
  // parent-directory chain for immutability / fd-binding to defeat a co-resident
  // local attacker, and preserving the configured argv0 for symlinked
  // executables. Neither affects the pilot; revisit per D-0056's trigger.
  try {
    const realExecutable = await fs.promises.realpath(executable);
    const realRoot = await fs.promises
      .realpath(agentWritableRoot)
      .catch(() => path.resolve(agentWritableRoot));
    const within =
      realExecutable === realRoot ||
      realExecutable.startsWith(realRoot + path.sep);
    if (within) {
      throw new StructuredLocalCliInvocationError(
        'executable_identity_mismatch',
        'Capability executable must not live under the agent-writable workspace.',
      );
    }
    const stat = await fs.promises.stat(realExecutable);
    if ((stat.mode & 0o022) !== 0) {
      throw new StructuredLocalCliInvocationError(
        'executable_identity_mismatch',
        'Capability executable is group/other-writable and cannot be pinned.',
      );
    }
    await fs.promises.access(realExecutable, fs.constants.X_OK);
    const actualHash = await sha256File(realExecutable);
    if (`sha256:${actualHash}` !== normalizedExpected) {
      throw new StructuredLocalCliInvocationError(
        'executable_identity_mismatch',
        'Capability executable identity does not match the reviewed hash.',
      );
    }
    return realExecutable;
  } catch (error) {
    if (error instanceof StructuredLocalCliInvocationError) throw error;
    throw new StructuredLocalCliInvocationError(
      'executable_identity_mismatch',
      'Capability executable identity could not be verified.',
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
