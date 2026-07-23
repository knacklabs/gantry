import { spawn } from 'node:child_process';
import { sanitizeOutboundLlmText } from '../../shared/sensitive-material.js';

const PEM_PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gi;
// Tail truncation can slice a PEM block so only one marker (or neither)
// survives in the retained window; orphaned fragments must still redact.
const PEM_ORPHAN_END_PATTERN =
  /^[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i;
const PEM_ORPHAN_BEGIN_PATTERN =
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*$/i;
const BASE64_KEY_BODY_RUN_PATTERN = /(?:^[A-Za-z0-9+/=]{40,}(?:\r?\n|$)){3,}/gm;

export interface ApprovedCommandRunInput {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  stdoutMaxBytes?: number;
  stderrMaxBytes?: number;
  redactOutput?: (value: string) => string;
}

export interface ApprovedCommandRunResult {
  stdout: string;
  stderr: string;
}

export function runApprovedSandboxCommand(
  input: ApprovedCommandRunInput,
): Promise<ApprovedCommandRunResult> {
  const [command, ...args] = input.argv;
  if (!command) throw new Error('Command is empty.');
  if (input.signal?.aborted) {
    return Promise.reject(new Error('Command aborted.'));
  }
  const stdoutMaxBytes = input.stdoutMaxBytes ?? 4000;
  const stderrMaxBytes = input.stderrMaxBytes ?? 4000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let settled = false;
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const terminate = () => {
      killProcessGroup(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => {
        killProcessGroup(child, 'SIGKILL');
      }, 1_000);
      forceKillTimer.unref?.();
    };
    const onAbort = () => {
      terminate();
    };
    if (input.signal) {
      if (input.signal.aborted) terminate();
      else input.signal.addEventListener('abort', onAbort, { once: true });
    }
    let stdoutTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      stdoutTail = retainBufferTail(stdoutTail, chunk, stdoutMaxBytes + 1);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      stderrTail = retainBufferTail(stderrTail, chunk, stderrMaxBytes + 1);
    });
    child.on('error', (err) => {
      settle(() => reject(err));
    });
    child.on('close', (code, signal) => {
      if (input.signal?.aborted) {
        settle(() => reject(new Error('Command aborted.')));
        return;
      }
      if (timedOut) {
        settle(() =>
          reject(
            new Error(
              `Command timed out${signal ? ` with signal ${signal}` : ''}.`,
            ),
          ),
        );
        return;
      }
      if (code === null && signal) {
        settle(() =>
          reject(new Error(`Command timed out with signal ${signal}.`)),
        );
        return;
      }
      const stdout = decodeRetainedTail(stdoutTail, stdoutMaxBytes).trim();
      const stderr = decodeRetainedTail(stderrTail, stderrMaxBytes).trim();
      if (code === 0) {
        settle(() =>
          resolve({
            stdout: input.redactOutput ? input.redactOutput(stdout) : stdout,
            stderr: input.redactOutput ? input.redactOutput(stderr) : stderr,
          }),
        );
        return;
      }
      const useStderr = Boolean(stderr);
      const failureOutputTruncated = useStderr
        ? stderrBytes > stderrMaxBytes
        : stdoutBytes > stdoutMaxBytes;
      const failureTail = sanitizeRetainedFailureTail(
        useStderr ? stderrTail : stdoutTail,
        useStderr ? stderrMaxBytes : stdoutMaxBytes,
        failureOutputTruncated,
      );
      const sanitized = failureOutputTruncated
        ? `[REDACTED_TRUNCATED_OUTPUT]${failureTail ? `\n${failureTail}` : ''}`
        : failureTail;
      const callerRedacted = input.redactOutput
        ? input.redactOutput(sanitized)
        : sanitized;
      settle(() =>
        reject(
          new Error(
            `Command failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}${callerRedacted ? `: ${callerRedacted}` : ''}`,
          ),
        ),
      );
    });
  });
}

function retainBufferTail(
  retained: Buffer,
  chunk: Buffer,
  maxBytes: number,
): Buffer {
  const next = Buffer.concat([retained, chunk]);
  return next.length > maxBytes ? next.subarray(next.length - maxBytes) : next;
}

function decodeRetainedTail(retained: Buffer, maxBytes: number): string {
  const boundary = Math.max(0, retained.length - maxBytes);
  return retained.subarray(boundary).toString('utf8');
}

function sanitizeRetainedFailureTail(
  retained: Buffer,
  maxBytes: number,
  truncated: boolean,
): string {
  const boundary = Math.max(0, retained.length - maxBytes);
  let tail = retained.subarray(boundary).toString('utf8');
  if (truncated) {
    // The runner retains one byte beyond the window; when that byte is a
    // newline the tail already starts at a complete line — keep it instead
    // of discarding a possibly-final diagnostic.
    const startsAtLineBoundary =
      boundary > 0 && retained[boundary - 1] === 0x0a;
    if (!startsAtLineBoundary) {
      tail = tail.replace(/^[^\r\n]*(?:\r?\n|$)/, '');
    }
    // Truncation may have sliced off a credential label, leaving its
    // continuation lines (indented values, sequence items) label-less at the
    // head of the tail where no redactor recognizes them. Drop leading
    // continuation-shaped lines until the first clearly fresh statement.
    const lines = tail.split(/\r?\n/);
    let start = 0;
    while (
      start < lines.length &&
      (/^\s*$/.test(lines[start] as string) ||
        /^\s+\S/.test(lines[start] as string) ||
        (lines[start] as string).trimStart().startsWith('- '))
    ) {
      start += 1;
    }
    tail = lines.slice(start).join('\n');
  }
  return sanitizeFailureDiagnostic(tail.trim());
}

function sanitizeFailureDiagnostic(value: string): string {
  const trimmed = value.trim();
  if (
    /^(?:authentication failed|no credentials configured|credentials could not be found|token has expired|session closed unexpectedly)$/i.test(
      trimmed,
    )
  ) {
    return trimmed;
  }
  let pemSanitized = value.replace(
    PEM_PRIVATE_KEY_BLOCK_PATTERN,
    '[REDACTED_SECRET]',
  );
  if (
    /-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i.test(pemSanitized)
  ) {
    pemSanitized = pemSanitized.replace(
      PEM_ORPHAN_END_PATTERN,
      '[REDACTED_SECRET]',
    );
  }
  pemSanitized = pemSanitized
    .replace(PEM_ORPHAN_BEGIN_PATTERN, '[REDACTED_SECRET]')
    .replace(BASE64_KEY_BODY_RUN_PATTERN, '[REDACTED_SECRET]\n');
  const urlSanitized = pemSanitized.replace(
    /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"']+/g,
    (rawUrl): string => {
      try {
        const url = new URL(rawUrl);
        let changed = false;
        if (url.username || url.password) {
          url.username = '***';
          url.password = '';
          changed = true;
        }
        for (const name of [...url.searchParams.keys()]) {
          const normalizedName = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
          if (
            [normalizedName, name.toLowerCase()].some((candidate) =>
              /(?:^|[^a-z0-9])(?:(?:api|access|private)[_-]?keys?|(?:access|auth|refresh|session)[_-]?tokens?|client[_-]?secrets?|auth(?:orization)?|cookies?|credentials?|keys?|passphrases?|passwords?|passwd|sigs?|signatures?|tokens?|secrets?)(?:$|[^a-z0-9])/i.test(
                candidate,
              ),
            )
          ) {
            url.searchParams.set(name, '***');
            changed = true;
          }
        }
        return changed ? url.toString() : rawUrl;
      } catch {
        return '[REDACTED_MALFORMED_URL]';
      }
    },
  );
  // A credential label introducing a YAML block scalar (password: | / >) or
  // an empty value hides its secret on the MORE-INDENTED continuation
  // lines; drop the whole block, not just the labelled line.
  let labelSanitized = redactLabelledContinuationBlocks(urlSanitized);
  for (const pattern of [
    /(^|[^A-Za-z0-9])["']?(?:auth|access|api|private|client|refresh|session)(?:tokens?|secrets?|passwords?|passphrases?|credentials?|keys?|cookies?)["']?\s*(?:=|:|is)\s*["']?(?!\*+)[^\r\n]*/gi,
    /(^|[^A-Za-z0-9])["']?(?:[A-Za-z0-9]+[_-])*(?:tokens?|secrets?|passwords?|passphrases?|credentials?|auth(?:orization)?|api[\s_-]?keys?|access[\s_-]?keys?|private[\s_-]?keys?|sessions?|cookies?|bearer)(?:[_-][A-Za-z0-9]+)*["']?\s*(?:=|:|is)\s*["']?(?!\*+)[^\r\n]*/gi,
    /(^|[^A-Za-z0-9])["']?(?:[A-Za-z0-9]+[_-])*(?:tokens?|secrets?|passwords?|passphrases?|credentials?|auth(?:orization)?|api[\s_-]?keys?|access[\s_-]?keys?|private[\s_-]?keys?|sessions?|cookies?|bearer)(?:[_-][A-Za-z0-9]+)*["']?\s+(?!\*+)[^\r\n]*/gi,
  ]) {
    labelSanitized = labelSanitized.replace(
      pattern,
      '$1[REDACTED_POTENTIALLY_SENSITIVE]',
    );
  }
  return sanitizeOutboundLlmText(labelSanitized).text;
}

// The label prefix/suffix allow spaces so compound labels ("database
// password: |") still open a redacted block.
const CREDENTIAL_LABEL_LINE_PATTERN =
  /^(\s*)["']?[A-Za-z0-9_. \t-]*(?:tokens?|secrets?|passwords?|passphrases?|credentials?|auth(?:orization)?|api[\s_-]?keys?|access[\s_-]?keys?|private[\s_-]?keys?|cookies?|bearer)[A-Za-z0-9_. \t-]*["']?\s*[:=]\s*(.*)$/i;

function redactLabelledContinuationBlocks(value: string): string {
  const lines = value.split(/\r?\n/);
  const out: string[] = [];
  let blockIndent: number | null = null;
  for (const line of lines) {
    if (blockIndent !== null) {
      const indent = line.length - line.trimStart().length;
      // YAML sequence items may sit at the SAME indent as their label
      // (passwords:\n- hunter2) — they are still continuations.
      if (
        line.trim() === '' ||
        indent > blockIndent ||
        (indent >= blockIndent && line.trim().startsWith('- '))
      ) {
        continue;
      }
      blockIndent = null;
    }
    const match = CREDENTIAL_LABEL_LINE_PATTERN.exec(line);
    const rest = match?.[2]?.trim();
    if (
      match &&
      (rest === '' ||
        rest?.startsWith('|') ||
        rest?.startsWith('>') ||
        rest?.startsWith('[') ||
        rest?.startsWith('{') ||
        rest?.startsWith('('))
    ) {
      blockIndent = match[1].length;
      out.push(`${match[1]}[REDACTED_POTENTIALLY_SENSITIVE]`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function killProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (err) {
      const code =
        err instanceof Error ? (err as NodeJS.ErrnoException).code : '';
      if (code === 'ESRCH') return;
    }
  }
  child.kill(signal);
}
