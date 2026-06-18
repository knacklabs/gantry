import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type {
  RunnerSandboxProvider,
  RunnerSandboxProviderSelection,
  RunnerSandboxResourceLimits,
  RunnerSandboxSpawnInput,
  RunnerSandboxWarmTemplateStatus,
} from '../../shared/runner-sandbox-provider.js';

interface PreparedCommand {
  command: string;
  args: string[];
}

export interface SandboxRuntimeWarmTemplate {
  readonly authorityFree: true;
  readonly network: {
    readonly deniedDomains: readonly string[];
    readonly allowLocalBinding: false;
  };
  readonly filesystem: {
    readonly homeSecretDenySuffixes: readonly string[];
    readonly cwdEnvDenyFilename: '.env';
    readonly usesUidScopedToolTemp: boolean;
  };
  readonly enableWeakerNetworkIsolation?: true;
}

const HOME_SECRET_DENY_SUFFIXES = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.azure',
  '.claude',
  '.codex',
  '.anthropic',
  '.config/gh',
  '.config/github-copilot',
  '.config/codex',
  '.config/gcloud',
  '.kube',
  '.docker',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.env',
] as const;

let cachedSandboxRuntimeWarmTemplate:
  | Readonly<SandboxRuntimeWarmTemplate>
  | undefined;
let cachedSandboxRuntimeCli: string | undefined;

export function createRunnerSandboxProvider(
  settings: RunnerSandboxProviderSelection,
): RunnerSandboxProvider {
  if (settings.provider === 'sandbox_runtime') {
    return new SandboxRuntimeRunnerSandboxProvider(settings.resourceLimits);
  }
  return new DirectRunnerSandboxProvider(settings.resourceLimits);
}

export class DirectRunnerSandboxProvider implements RunnerSandboxProvider {
  readonly id = 'direct' as const;
  readonly enforcing = false;

  constructor(
    private readonly resourceLimits: RunnerSandboxResourceLimits = {
      cpuSeconds: 0,
      memoryMb: 0,
      maxProcesses: 0,
    },
  ) {}

  warmTemplate(): RunnerSandboxWarmTemplateStatus {
    return {
      available: false,
      cacheHit: false,
      authorityFree: true,
    };
  }

  start(input: RunnerSandboxSpawnInput) {
    const prepared = applyResourceLimits(
      input.command,
      input.args,
      input.resourceLimits ?? this.resourceLimits,
    );
    return spawn(prepared.command, prepared.args, {
      cwd: input.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: input.env,
    });
  }
}

class SandboxRuntimeRunnerSandboxProvider implements RunnerSandboxProvider {
  readonly id = 'sandbox_runtime' as const;
  readonly enforcing = true;

  constructor(private readonly resourceLimits: RunnerSandboxResourceLimits) {}

  warmTemplate(): RunnerSandboxWarmTemplateStatus {
    return sandboxRuntimeWarmTemplateStatus();
  }

  start(input: RunnerSandboxSpawnInput) {
    if (process.platform === 'win32') {
      throw new Error('Sandbox runtime is not supported on Windows.');
    }
    if (!input.configFilePath) {
      throw new Error('Sandbox runtime requires a config file path.');
    }
    if (input.sandboxProfile.network === 'required' && !input.egressProxyUrl) {
      throw new Error(
        'Networked sandbox runs require the Gantry egress proxy.',
      );
    }
    fs.mkdirSync(path.dirname(input.configFilePath), {
      recursive: true,
      mode: 0o700,
    });
    fs.writeFileSync(
      input.configFilePath,
      JSON.stringify(buildSandboxRuntimeConfig(input), null, 2),
      { mode: 0o600 },
    );
    const cli = resolveSandboxRuntimeCli();
    const limited = applyResourceLimits(
      input.command,
      input.args,
      input.resourceLimits ?? this.resourceLimits,
    );
    const child = spawn(
      process.execPath,
      [
        cli,
        '--settings',
        input.configFilePath,
        '--',
        limited.command,
        ...limited.args,
      ],
      {
        cwd: input.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: input.env,
        detached: true,
      },
    );
    installProcessGroupKill(child);
    return child;
  }
}

export function buildSandboxRuntimeWarmTemplate(): Readonly<SandboxRuntimeWarmTemplate> {
  if (!cachedSandboxRuntimeWarmTemplate) {
    cachedSandboxRuntimeWarmTemplate = Object.freeze({
      authorityFree: true,
      network: Object.freeze({
        deniedDomains: Object.freeze([]),
        allowLocalBinding: false,
      }),
      filesystem: Object.freeze({
        homeSecretDenySuffixes: Object.freeze([...HOME_SECRET_DENY_SUFFIXES]),
        cwdEnvDenyFilename: '.env',
        usesUidScopedToolTemp: process.platform === 'darwin',
      }),
      ...(process.platform === 'darwin'
        ? { enableWeakerNetworkIsolation: true as const }
        : {}),
    });
  }
  return cachedSandboxRuntimeWarmTemplate;
}

function sandboxRuntimeWarmTemplateStatus(): RunnerSandboxWarmTemplateStatus {
  const cacheHit = cachedSandboxRuntimeWarmTemplate !== undefined;
  buildSandboxRuntimeWarmTemplate();
  return {
    available: true,
    cacheHit,
    authorityFree: true,
  };
}

function applyResourceLimits(
  command: string,
  args: string[],
  limits: RunnerSandboxResourceLimits,
): PreparedCommand {
  if (
    limits.cpuSeconds <= 0 &&
    limits.memoryMb <= 0 &&
    limits.maxProcesses <= 0
  ) {
    return { command, args };
  }
  if (process.platform === 'win32') {
    throw new Error(
      'runtime.sandbox.resource_limits are not supported on Windows direct mode.',
    );
  }
  const script = [
    limits.cpuSeconds > 0 ? `ulimit -t ${limits.cpuSeconds} || exit 125` : '',
    limits.memoryMb > 0
      ? `ulimit -v ${limits.memoryMb * 1024} 2>/dev/null || true`
      : '',
    limits.maxProcesses > 0
      ? `ulimit -u ${limits.maxProcesses} 2>/dev/null || true`
      : '',
    'exec "$0" "$@"',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    command: '/bin/sh',
    args: ['-c', script, command, ...args],
  };
}

function buildSandboxRuntimeConfig(input: RunnerSandboxSpawnInput) {
  const template = buildSandboxRuntimeWarmTemplate();
  const denyRead = uniquePaths([
    ...siblingReadDenyPaths(input),
    ...defaultReadDenyPaths(input),
    ...input.protectedReadPaths,
  ]);
  return {
    network: {
      deniedDomains: [...template.network.deniedDomains],
      allowLocalBinding: template.network.allowLocalBinding,
      allowedDomains:
        input.sandboxProfile.network === 'required'
          ? sandboxAllowedDomainsFromHosts(input.allowedNetworkHosts)
          : [],
      ...(input.sandboxProfile.network === 'required'
        ? egressProxyConfig(input.egressProxyUrl)
        : {}),
    },
    filesystem: {
      denyRead,
      allowRead:
        denyRead.length > 0
          ? uniquePaths(defaultReadAllowPaths(input, denyRead))
          : [],
      allowWrite:
        input.sandboxProfile.filesystem === 'workspace_write'
          ? uniquePaths([
              input.workspaceRoot,
              ...input.runtimeWritePaths,
              ...defaultToolTempWriteAllowPaths(),
            ])
          : [],
      denyWrite: uniquePaths([
        ...defaultWriteDenyPaths(input),
        ...input.protectedWritePaths,
      ]),
    },
    ...(template.enableWeakerNetworkIsolation
      ? { enableWeakerNetworkIsolation: true }
      : {}),
  };
}

function siblingReadDenyPaths(input: RunnerSandboxSpawnInput): string[] {
  return uniquePaths(
    [input.workspaceRoot, ...input.runtimeReadPaths]
      .map((item) => {
        const resolved = path.resolve(item);
        const parent = path.dirname(resolved);
        return isSafeSiblingDenyRoot(parent) ? parent : '';
      })
      .filter(Boolean),
  );
}

function isSafeSiblingDenyRoot(root: string): boolean {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) return false;
  const home = os.homedir();
  if (home && resolved === path.resolve(home)) return false;
  const tmp = path.resolve(os.tmpdir());
  if (resolved === tmp || resolved === '/tmp' || resolved === '/private/tmp') {
    return false;
  }
  return true;
}

function defaultToolTempWriteAllowPaths(): string[] {
  if (!buildSandboxRuntimeWarmTemplate().filesystem.usesUidScopedToolTemp) {
    return [];
  }
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  return [`/tmp/claude-${uid}`, `/private/tmp/claude-${uid}`];
}

function installProcessGroupKill(child: ReturnType<typeof spawn>): void {
  const killOne = child.kill.bind(child);
  child.kill = ((signal?: NodeJS.Signals | number) => {
    if (process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch (err) {
        const code =
          err instanceof Error ? (err as NodeJS.ErrnoException).code : '';
        if (code === 'ESRCH') return false;
      }
    }
    return killOne(signal);
  }) as typeof child.kill;
}

function egressProxyConfig(proxyUrl: string | undefined): {
  httpProxyPort: number;
} {
  if (!proxyUrl) {
    throw new Error('Sandbox egress proxy URL is missing.');
  }
  const parsed = new URL(proxyUrl);
  if (parsed.protocol !== 'http:') {
    throw new Error('Sandbox egress proxy must use http.');
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('Sandbox egress proxy must be loopback.');
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('Sandbox egress proxy must include a numeric port.');
  }
  return { httpProxyPort: port };
}

function sandboxAllowedDomainsFromHosts(hosts: readonly string[]): string[] {
  const domains = new Set<string>();
  for (const host of hosts) {
    const normalized = sandboxAllowedDomainFromHost(host);
    if (normalized) domains.add(normalized);
  }
  return [...domains].sort();
}

function sandboxAllowedDomainFromHost(host: string): string | null {
  const trimmed = host.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed) return null;
  let candidate: string | null = trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    try {
      candidate = new URL(candidate).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
      return null;
    }
  } else {
    candidate = hostWithoutPort(candidate);
  }
  if (!candidate) return null;
  candidate = unbracketIpv6(candidate).replace(/\.$/, '');
  if (candidate === 'localhost') return candidate;
  const ipVersion = isIP(candidate);
  if (ipVersion === 4) return candidate;
  if (ipVersion === 6) return null;
  return candidate;
}

function hostWithoutPort(value: string): string | null {
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return null;
    const rest = value.slice(end + 1);
    if (rest && !rest.startsWith(':')) return null;
    return value.slice(0, end + 1);
  }
  const colon = value.indexOf(':');
  if (colon === -1) return value;
  if (colon !== value.lastIndexOf(':')) return null;
  return value.slice(0, colon);
}

function unbracketIpv6(value: string): string {
  return value.startsWith('[') && value.endsWith(']')
    ? value.slice(1, -1)
    : value;
}

function defaultReadDenyPaths(input: RunnerSandboxSpawnInput): string[] {
  const home = os.homedir();
  const paths = [
    ...homeSecretReadDenyPaths(home),
    ...(home && home !== '/' ? [path.join(home, 'gantry', '.env')] : []),
    path.join(input.workspaceRoot, '.env'),
    path.join(input.cwd, '.env'),
  ];
  for (const runtimePath of input.runtimeReadPaths) {
    paths.push(path.join(runtimePath, '.env'));
  }
  return paths;
}

function defaultWriteDenyPaths(input: RunnerSandboxSpawnInput): string[] {
  const home = os.homedir();
  return [
    '/tmp/claude',
    '/private/tmp/claude',
    path.join(input.workspaceRoot, '.env'),
    path.join(input.cwd, '.env'),
    ...input.runtimeReadPaths.map((runtimePath) =>
      path.join(runtimePath, '.env'),
    ),
    ...(home && home !== '/'
      ? [
          path.join(home, 'gantry', '.env'),
          path.join(home, '.npm', '_logs'),
          path.join(home, '.claude', 'debug'),
        ]
      : []),
  ];
}

function homeSecretReadDenyPaths(home: string): string[] {
  if (!home || home === '/') return [];
  return buildSandboxRuntimeWarmTemplate().filesystem.homeSecretDenySuffixes.map(
    (item) => path.join(home, item),
  );
}

function defaultReadAllowPaths(
  input: RunnerSandboxSpawnInput,
  denyReadPaths: readonly string[],
): string[] {
  const paths = [
    process.execPath,
    path.dirname(process.execPath),
    path.dirname(path.dirname(process.execPath)),
    ...executableReadAllowPaths(input.command),
    '/bin',
    '/usr/bin',
    '/usr/local/bin',
    '/usr/lib',
    '/usr/local/lib',
    '/lib',
    '/lib64',
    '/System',
    '/Library/Developer/CommandLineTools',
    ...claudeCodeExecutableReadAllowPaths(process.env.PATH),
    ...workspaceCwdReadAllowPaths(input),
    ...expandReadAllowRoot(input.workspaceRoot, denyReadPaths),
    ...runtimeReadRootDirectoryAllowPaths(input.runtimeReadPaths),
  ];
  for (const runtimePath of input.runtimeReadPaths) {
    paths.push(...expandReadAllowRoot(runtimePath, denyReadPaths));
  }
  try {
    const realNode = fs.realpathSync(process.execPath);
    paths.push(
      realNode,
      path.dirname(realNode),
      path.dirname(path.dirname(realNode)),
    );
  } catch {
    // Best effort only; the configured executable path remains allowed above.
  }
  if (process.platform === 'darwin') {
    paths.push('/opt/homebrew', '/usr/local');
  }
  return paths;
}

function runtimeReadRootDirectoryAllowPaths(
  runtimeReadPaths: readonly string[],
): string[] {
  if (process.platform !== 'darwin') return [];
  return runtimeReadPaths.flatMap((runtimePath) =>
    exactMacosPathReadAllowPattern(runtimePath),
  );
}

function claudeCodeExecutableReadAllowPaths(
  envPath: string | undefined,
): string[] {
  if (!envPath) return [];
  const home = os.homedir();
  const allowedRoots = [
    '/usr/local',
    '/opt/homebrew',
    ...(home && home !== '/'
      ? [
          path.join(home, '.local', 'bin'),
          path.join(home, '.local', 'share', 'claude', 'versions'),
        ]
      : []),
  ];
  for (const entry of envPath.split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue;
    const candidate = path.join(entry, 'claude');
    try {
      if (!fs.existsSync(candidate)) continue;
      const resolved = fs.realpathSync(candidate);
      if (
        !allowedRoots.some((root) =>
          pathContainsOrEquals(path.resolve(root), path.resolve(resolved)),
        )
      ) {
        continue;
      }
      return uniquePaths([
        candidate,
        path.dirname(candidate),
        resolved,
        path.dirname(resolved),
      ]);
    } catch {
      continue;
    }
  }
  return [];
}

function executableReadAllowPaths(command: string): string[] {
  if (!path.isAbsolute(command)) return [];
  const paths = [command, path.dirname(command)];
  try {
    const realCommand = fs.realpathSync(command);
    paths.push(realCommand, path.dirname(realCommand));
  } catch {
    // Best effort only; the configured executable path remains allowed above.
  }
  return paths;
}

function workspaceCwdReadAllowPaths(input: RunnerSandboxSpawnInput): string[] {
  if (process.platform !== 'darwin') return [];
  if (!pathContainsOrEquals(input.workspaceRoot, input.cwd)) return [];
  return exactMacosPathReadAllowPattern(input.cwd);
}

function exactMacosPathReadAllowPattern(targetPath: string): string[] {
  const normalized = path.resolve(targetPath).replace(/\/+$/, '');
  const basename = path.basename(normalized);
  if (!/^[A-Za-z0-9._-]+$/.test(basename)) return [];
  const parent = path.dirname(normalized);
  const lastIndex = basename.length - 1;
  const patternBasename = `${basename.slice(0, lastIndex)}[${basename[lastIndex]}]`;
  return [path.join(parent, patternBasename)];
}

function expandReadAllowRoot(
  root: string,
  protectedReadPaths: readonly string[],
): string[] {
  const resolvedRoot = path.resolve(root);
  const protectedPaths = protectedReadPaths.map((item) => path.resolve(item));
  if (
    !protectedPaths.some((protectedPath) =>
      pathContainsOrEquals(resolvedRoot, protectedPath),
    )
  ) {
    return [root];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const allowed: string[] = [];
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    const resolvedChild = path.resolve(child);
    const matchingProtectedPath = protectedPaths.find((protectedPath) =>
      pathContainsOrEquals(resolvedChild, protectedPath),
    );
    const protectedInsideChild = Boolean(matchingProtectedPath);
    if (!protectedInsideChild) {
      allowed.push(child);
      continue;
    }
    if (
      entry.isDirectory() &&
      matchingProtectedPath &&
      path.resolve(child) !== matchingProtectedPath
    ) {
      allowed.push(...expandReadAllowRoot(child, protectedPaths));
    }
  }
  return allowed;
}

function pathContainsOrEquals(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((item) => item.trim().length > 0))];
}

function resolveSandboxRuntimeCli(): string {
  if (cachedSandboxRuntimeCli) return cachedSandboxRuntimeCli;
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('@anthropic-ai/sandbox-runtime/package.json');
  cachedSandboxRuntimeCli = path.join(path.dirname(pkgPath), 'dist', 'cli.js');
  return cachedSandboxRuntimeCli;
}
