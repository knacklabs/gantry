import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  AGENT_MAX_OUTPUT_SIZE,
  AGENT_TIMEOUT,
  IDLE_TIMEOUT,
  LOG_LEVEL,
} from '../config/index.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { logger, redactString } from '../infrastructure/logging/logger.js';
import { AgentOutput, RunnerProcessSpec } from './agent-spawn-types.js';
import { activeRunStopWasRequested } from './group-queue-stop.js';
import { formatDuration } from '../shared/human-format.js';
import { nowIso, nowMs as currentTimeMs } from '../shared/time/datetime.js';

const OUTPUT_START_MARKER = '---MYCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---MYCLAW_OUTPUT_END---';

const SENSITIVE_TEXT_PATTERNS: RegExp[] = [
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH)[A-Z0-9_]*)\s*[:=]\s*([^\s"']+)/gi,
  /\b(Bearer)\s+[A-Za-z0-9._\-~+/]+=*/gi,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const STREAM_PARSE_BUFFER_LIMIT = Math.max(AGENT_MAX_OUTPUT_SIZE * 4, 131_072);
const DEFAULT_SCHEDULED_JOB_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_SCHEDULED_JOB_IDLE_TIMEOUT_MS = 60 * 1000;

type RunnerTimeoutReason = 'timeout' | 'scheduled_job_idle_stall';

interface ScheduledJobHeartbeatPayload {
  lastTool?: string;
  currentTool?: string;
  lastActivityAt?: string;
  lastActivityAgoMs?: number;
  pendingPermissionRequests?: number;
  pendingPermissionToolNames?: string[];
  totalToolCalls?: number;
}

function formatResumeSessionStatus(sessionId?: string): string {
  return sessionId ? 'present' : 'none';
}

function sanitizeLogText(value: string, maxChars = 4000): string {
  let text = redactString(value);
  for (const pattern of SENSITIVE_TEXT_PATTERNS) {
    text = text.replace(pattern, (_match, p1) => {
      if (typeof p1 === 'string' && p1.length > 0) {
        return `${p1}=[REDACTED]`;
      }
      return '[REDACTED]';
    });
  }
  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}...[truncated]`;
  }
  return text;
}

function parseBufferedRunnerOutput(stdout: string): AgentOutput {
  const endIdx = stdout.lastIndexOf(OUTPUT_END_MARKER);
  const startIdx =
    endIdx === -1 ? -1 : stdout.lastIndexOf(OUTPUT_START_MARKER, endIdx);

  let jsonLine: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    jsonLine = stdout
      .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
      .trim();
  } else {
    const lines = stdout.trim().split('\n');
    jsonLine = lines[lines.length - 1];
  }

  return JSON.parse(jsonLine) as AgentOutput;
}

function runnerContextPayload(input: RunnerProcessSpec['input']) {
  return {
    appId: input.appId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    jobId: input.jobId,
    runId: input.runId,
  };
}

function scheduledJobIdleTimeoutMs(): number {
  const raw = process.env.MYCLAW_SCHEDULED_JOB_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_SCHEDULED_JOB_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SCHEDULED_JOB_IDLE_TIMEOUT_MS;
  }
  return Math.max(MIN_SCHEDULED_JOB_IDLE_TIMEOUT_MS, Math.trunc(parsed));
}

function readScheduledJobHeartbeat(
  output: AgentOutput,
): ScheduledJobHeartbeatPayload | null {
  for (const event of output.runtimeEvents ?? []) {
    if (event.eventType !== RUNTIME_EVENT_TYPES.JOB_HEARTBEAT) continue;
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') return null;
    const record = payload as Record<string, unknown>;
    return {
      lastTool:
        typeof record.lastTool === 'string' ? record.lastTool : undefined,
      currentTool:
        typeof record.currentTool === 'string' ? record.currentTool : undefined,
      lastActivityAt:
        typeof record.lastActivityAt === 'string'
          ? record.lastActivityAt
          : undefined,
      lastActivityAgoMs:
        typeof record.lastActivityAgoMs === 'number'
          ? record.lastActivityAgoMs
          : undefined,
      pendingPermissionRequests:
        typeof record.pendingPermissionRequests === 'number'
          ? record.pendingPermissionRequests
          : undefined,
      pendingPermissionToolNames: Array.isArray(
        record.pendingPermissionToolNames,
      )
        ? record.pendingPermissionToolNames.filter(
            (toolName): toolName is string => typeof toolName === 'string',
          )
        : undefined,
      totalToolCalls:
        typeof record.totalToolCalls === 'number'
          ? record.totalToolCalls
          : undefined,
    };
  }
  return null;
}

function formatScheduledJobIdleStallError(input: {
  timeoutMs: number;
  heartbeat?: ScheduledJobHeartbeatPayload | null;
  logFile?: string;
}): string {
  const { timeoutMs, heartbeat, logFile } = input;
  const pendingCount = heartbeat?.pendingPermissionRequests ?? 0;
  const pendingTools = heartbeat?.pendingPermissionToolNames?.length
    ? heartbeat.pendingPermissionToolNames.join(', ')
    : 'none';
  const parts = [
    `Scheduled job made no runner or tool progress for ${formatDuration(timeoutMs)}.`,
    `lastTool=${heartbeat?.lastTool ?? heartbeat?.currentTool ?? 'none'}`,
    `lastActivityAt=${heartbeat?.lastActivityAt ?? 'unknown'}`,
    `pendingPermissions=${pendingCount} (${pendingTools})`,
    `totalToolCalls=${heartbeat?.totalToolCalls ?? 0}`,
  ];
  if (logFile) parts.push(`logFile=${logFile}`);
  return parts.join(' ');
}

export function executeRunnerProcess(
  spec: RunnerProcessSpec,
): Promise<AgentOutput> {
  const {
    group,
    input,
    command,
    args,
    env,
    onProcess,
    onOutput,
    options,
    runnerLabel,
    processName,
    startTime,
    logsDir,
    runtimeDetails,
  } = spec;

  return new Promise((resolve) => {
    const runner = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    onProcess(runner, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    runner.stdin.write(JSON.stringify(input));
    runner.stdin.end();

    let parseBuffer = '';
    let parseBufferTruncated = false;
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let timedOut = false;
    let timeoutReason: RunnerTimeoutReason = 'timeout';
    let lastScheduledJobHeartbeat: ScheduledJobHeartbeatPayload | null = null;
    const scheduledJobIdleMs = scheduledJobIdleTimeoutMs();
    let hadStreamingOutput = false;
    const configuredTimeout =
      options?.timeoutMs ?? group.agentConfig?.timeout ?? AGENT_TIMEOUT;
    const hasExplicitTimeout = options?.timeoutMs != null;
    const timeoutMs = hasExplicitTimeout
      ? configuredTimeout
      : Math.max(configuredTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      timeoutReason = 'timeout';
      logger.error(
        { group: group.name, processName, ...runnerContextPayload(input) },
        `${runnerLabel} timeout, stopping`,
      );
      runner.kill('SIGKILL');
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);
    const resetTimeout = () => {
      if (hasExplicitTimeout && !input.isScheduledJob) return;
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    runner.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = AGENT_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Agent stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        if (parseBuffer.length > STREAM_PARSE_BUFFER_LIMIT) {
          const latestMarker = parseBuffer.lastIndexOf(OUTPUT_START_MARKER);
          if (latestMarker > 0) {
            parseBuffer = parseBuffer.slice(latestMarker);
          }
          if (parseBuffer.length > STREAM_PARSE_BUFFER_LIMIT) {
            parseBuffer = parseBuffer.slice(-STREAM_PARSE_BUFFER_LIMIT);
          }
          if (!parseBufferTruncated) {
            parseBufferTruncated = true;
            logger.warn(
              { group: group.name, limit: STREAM_PARSE_BUFFER_LIMIT },
              'Streaming parse buffer exceeded limit and was trimmed',
            );
          }
        }
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: AgentOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            const heartbeat = readScheduledJobHeartbeat(parsed);
            if (input.isScheduledJob && heartbeat) {
              lastScheduledJobHeartbeat = heartbeat;
              const pendingPermissions =
                heartbeat.pendingPermissionRequests ?? 0;
              const idleForMs = heartbeat.lastActivityAgoMs ?? 0;
              if (pendingPermissions === 0 && idleForMs >= scheduledJobIdleMs) {
                timedOut = true;
                timeoutReason = 'scheduled_job_idle_stall';
                logger.error(
                  {
                    group: group.name,
                    processName,
                    idleForMs,
                    scheduledJobIdleMs,
                    lastTool: heartbeat.lastTool ?? heartbeat.currentTool,
                    lastActivityAt: heartbeat.lastActivityAt,
                    totalToolCalls: heartbeat.totalToolCalls,
                    ...runnerContextPayload(input),
                  },
                  `${runnerLabel} scheduled job idle stall, stopping`,
                );
                runner.kill('SIGKILL');
              }
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain
              .then(() => onOutput(parsed))
              .catch((err) => {
                logger.error(
                  {
                    group: group.name,
                    error: err instanceof Error ? err.message : String(err),
                  },
                  'onOutput callback failed',
                );
              });
          } catch (err) {
            logger.warn(
              {
                group: group.name,
                error: err instanceof Error ? err.message : String(err),
              },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    runner.stderr.on('data', (data) => {
      const chunk = data.toString();
      const sanitizedChunkForLog = sanitizeLogText(
        chunk,
        AGENT_MAX_OUTPUT_SIZE,
      );
      const lines = sanitizedChunkForLog.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ agent: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = AGENT_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Agent stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    runner.on('close', (code, signal) => {
      clearTimeout(timeout);
      const duration = currentTimeMs() - startTime;

      if (timedOut) {
        const ts = nowIso().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `agent-${ts}.log`);
        const timeoutTitle =
          timeoutReason === 'scheduled_job_idle_stall'
            ? 'SCHEDULED JOB IDLE STALL'
            : 'TIMEOUT';
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Agent Run Log (${timeoutTitle}) ===`,
            `Timestamp: ${nowIso()}`,
            `Group: ${group.name}`,
            `Process: ${processName}`,
            `App ID: ${input.appId ?? 'none'}`,
            `Agent ID: ${input.agentId ?? 'none'}`,
            `Session ID: ${input.sessionId ?? 'none'}`,
            `Job ID: ${input.jobId ?? 'none'}`,
            `Run ID: ${input.runId ?? 'none'}`,
            `Log File: ${timeoutLog}`,
            `Duration: ${formatDuration(duration)}`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
            ...(timeoutReason === 'scheduled_job_idle_stall'
              ? [
                  `Idle Timeout: ${formatDuration(scheduledJobIdleMs)}`,
                  `Last Tool: ${lastScheduledJobHeartbeat?.lastTool ?? lastScheduledJobHeartbeat?.currentTool ?? 'none'}`,
                  `Last Activity At: ${lastScheduledJobHeartbeat?.lastActivityAt ?? 'unknown'}`,
                  `Pending Permissions: ${lastScheduledJobHeartbeat?.pendingPermissionRequests ?? 0}`,
                  `Pending Permission Tools: ${
                    lastScheduledJobHeartbeat?.pendingPermissionToolNames
                      ?.length
                      ? lastScheduledJobHeartbeat.pendingPermissionToolNames.join(
                          ', ',
                        )
                      : 'none'
                  }`,
                  `Total Tool Calls: ${lastScheduledJobHeartbeat?.totalToolCalls ?? 0}`,
                ]
              : []),
          ].join('\n'),
        );

        if (
          hadStreamingOutput &&
          !hasExplicitTimeout &&
          timeoutReason === 'timeout'
        ) {
          logger.info(
            {
              group: group.name,
              processName,
              duration,
              code,
              logFile: timeoutLog,
              ...runnerContextPayload(input),
            },
            `${runnerLabel} timed out after output (idle cleanup)`,
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        const error =
          timeoutReason === 'scheduled_job_idle_stall'
            ? formatScheduledJobIdleStallError({
                timeoutMs: scheduledJobIdleMs,
                heartbeat: lastScheduledJobHeartbeat,
                logFile: timeoutLog,
              })
            : `${runnerLabel} timed out after ${formatDuration(timeoutMs)}`;

        logger.error(
          {
            group: group.name,
            processName,
            duration,
            code,
            hadStreamingOutput,
            logFile: timeoutLog,
            timeoutReason,
            ...runnerContextPayload(input),
          },
          timeoutReason === 'scheduled_job_idle_stall'
            ? `${runnerLabel} scheduled job idle stall`
            : hadStreamingOutput
              ? `${runnerLabel} timed out after streamed output`
              : `${runnerLabel} timed out with no output`,
        );

        outputChain.then(() => {
          resolve({
            status: 'error',
            result: null,
            newSessionId,
            error,
          });
        });
        return;
      }

      const timestamp = nowIso().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `agent-${timestamp}.log`);
      const isVerbose = LOG_LEVEL === 'debug' || LOG_LEVEL === 'trace';

      const logLines = [
        `=== Agent Run Log ===`,
        `Timestamp: ${nowIso()}`,
        `Group: ${group.name}`,
        `Duration: ${formatDuration(duration)}`,
        `Exit Code: ${code}`,
        `Signal: ${signal ?? 'none'}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;
      const sanitizedStdoutForLog = sanitizeLogText(
        stdout,
        AGENT_MAX_OUTPUT_SIZE,
      );
      const sanitizedStderrForLog = sanitizeLogText(
        stderr,
        AGENT_MAX_OUTPUT_SIZE,
      );
      if (isVerbose || isError) {
        if (isVerbose) {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `SDK session persistence: ${input.isScheduledJob ? 'disabled' : 'enabled'}`,
            `Resume session: ${formatResumeSessionStatus(input.sessionId)}`,
            `Chat JID: ${input.chatJid}`,
            `Group Folder: ${input.groupFolder}`,
            '',
          );
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `SDK session persistence: ${input.isScheduledJob ? 'disabled' : 'enabled'}`,
            `Resume session: ${formatResumeSessionStatus(input.sessionId)}`,
            ``,
          );
        }
        logLines.push(
          `=== Spawn Command ===`,
          [command, ...args].join(' '),
          ``,
          `=== Runtime Details ===`,
          runtimeDetails.join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          sanitizedStderrForLog,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          sanitizedStdoutForLog,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `SDK session persistence: ${input.isScheduledJob ? 'disabled' : 'enabled'}`,
          `Resume session: ${formatResumeSessionStatus(input.sessionId)}`,
          ``,
          `=== Runtime Details ===`,
          runtimeDetails.join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Agent log written');

      const stopRequested =
        signal === 'SIGTERM' && activeRunStopWasRequested(runner);
      const streamedSigterm =
        onOutput && signal === 'SIGTERM' && hadStreamingOutput;
      if (streamedSigterm && !stopRequested) {
        outputChain.then(() => {
          logger.info(
            {
              group: group.name,
              duration,
              providerSessionCreated: !!newSessionId,
              signal,
            },
            `${runnerLabel} closed after streamed output`,
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      if (stopRequested) {
        outputChain.then(() => {
          logger.warn(
            {
              group: group.name,
              duration,
              hadStreamingOutput,
              signal,
              ...runnerContextPayload(input),
            },
            `${runnerLabel} stopped by request`,
          );
          resolve({
            status: 'error',
            result: null,
            newSessionId,
            error: `${runnerLabel} stopped by request`,
          });
        });
        return;
      }

      if (code !== 0) {
        const sanitizedStdout = sanitizeLogText(stdout);
        const sanitizedStderr = sanitizeLogText(stderr);
        let structuredError: AgentOutput | null = null;
        try {
          const parsedOutput = parseBufferedRunnerOutput(stdout);
          if (parsedOutput.status === 'error') {
            structuredError = parsedOutput;
          }
        } catch {
          structuredError = null;
        }
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr: sanitizedStderr,
            stdout: sanitizedStdout,
            logFile,
          },
          `${runnerLabel} exited with error`,
        );

        if (structuredError) {
          outputChain.then(() => {
            resolve({
              ...structuredError,
              newSessionId: structuredError?.newSessionId ?? newSessionId,
            });
          });
        } else {
          resolve({
            status: 'error',
            result: null,
            error: `${runnerLabel} exited with code ${code}: ${sanitizeLogText(stderr.slice(-200), 200)}`,
          });
        }
        return;
      }

      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            {
              group: group.name,
              duration,
              providerSessionCreated: !!newSessionId,
            },
            `${runnerLabel} completed (streaming mode)`,
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      try {
        const output = parseBufferedRunnerOutput(stdout);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          `${runnerLabel} completed`,
        );

        resolve(output);
      } catch (err) {
        const sanitizedStdout = sanitizeLogText(stdout);
        const sanitizedStderr = sanitizeLogText(stderr);
        logger.error(
          {
            group: group.name,
            stdout: sanitizedStdout,
            stderr: sanitizedStderr,
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to parse runner output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse runner output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    runner.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, processName, error: err.message },
        `${runnerLabel} spawn error`,
      );
      resolve({
        status: 'error',
        result: null,
        error: `${runnerLabel} spawn error: ${err.message}`,
      });
    });
  });
}
