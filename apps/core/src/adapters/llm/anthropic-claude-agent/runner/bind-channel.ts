/**
 * Warm-pool bind receiver (Pillar 2, F3).
 *
 * A warm worker boots GENERIC (no customer identity / first message), signals
 * ready, then awaits a BIND that carries the per-customer scope over a
 * NON-stdin channel. Stdin is read once and closed at spawn
 * (`agent-spawn-process.ts`), so the bind cannot ride stdin.
 *
 * Transport is pluggable so the real Pillar-1 two-phase socket swaps in at
 * combine time. For the standalone worktree-B shim the bind arrives either as a
 * test-only env JSON (`GANTRY_SPIKE_BIND`, fast path) or as a `{type:'bind'}`
 * envelope written into `GANTRY_IPC_INPUT_DIR` (the existing continuation-input
 * dir). The receiver only reads the bind; it never mutates customer state
 * downstream.
 */
import fs from 'fs';
import path from 'path';
import { log } from './logging.js';

/**
 * The per-customer scope delivered at bind. Neutral fields only — the runner
 * merges these into the run after the generic boot.
 */
export interface ConversationBindScope {
  chatJid: string;
  firstMessage: string;
  memoryBlock?: string;
  guardrailPreface?: string;
  threadId?: string;
  /** Sample token usage echoed by the fake SDK for cache-plumbing assertions. */
  usage?: {
    in?: number;
    out?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface AwaitBindOptions {
  /** Poll interval for the IPC bind file (ms). */
  pollMs?: number;
  /** Max wait for the bind before giving up (ms). */
  timeoutMs?: number;
}

const DEFAULT_BIND_POLL_MS = 50;
const DEFAULT_BIND_TIMEOUT_MS = 30_000;
const BIND_FILE_NAME = '_bind.json';

function parseBindScope(raw: string): ConversationBindScope | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<ConversationBindScope> & {
      type?: string;
      scope?: Partial<ConversationBindScope>;
    };
    // Accept either a bare scope or a {type:'bind', scope:{...}} envelope.
    const scope: Partial<ConversationBindScope> =
      parsed && typeof parsed === 'object' && parsed.scope
        ? parsed.scope
        : parsed;
    if (
      !scope ||
      typeof scope.chatJid !== 'string' ||
      typeof scope.firstMessage !== 'string'
    ) {
      return undefined;
    }
    return {
      chatJid: scope.chatJid,
      firstMessage: scope.firstMessage,
      memoryBlock:
        typeof scope.memoryBlock === 'string' ? scope.memoryBlock : undefined,
      guardrailPreface:
        typeof scope.guardrailPreface === 'string'
          ? scope.guardrailPreface
          : undefined,
      threadId: typeof scope.threadId === 'string' ? scope.threadId : undefined,
      usage:
        scope.usage && typeof scope.usage === 'object'
          ? scope.usage
          : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Await the per-customer bind. Resolves with the scope once it arrives.
 * - Test-only fast path: `GANTRY_SPIKE_BIND` env (a JSON scope) resolves
 *   immediately, modelling an already-delivered bind.
 * - Shim path: poll `GANTRY_IPC_INPUT_DIR/_bind.json` until present.
 */
export async function awaitBind(
  options: AwaitBindOptions = {},
): Promise<ConversationBindScope> {
  const fast = process.env.GANTRY_SPIKE_BIND?.trim();
  if (fast) {
    const scope = parseBindScope(fast);
    if (scope) {
      log(`Warm bind received via env fast-path (chatJid=${scope.chatJid})`);
      return scope;
    }
    throw new Error('GANTRY_SPIKE_BIND was set but is not a valid bind scope');
  }

  const inputDir = process.env.GANTRY_IPC_INPUT_DIR;
  if (!inputDir) {
    throw new Error('Cannot await warm bind: GANTRY_IPC_INPUT_DIR is unset');
  }
  const bindPath = path.join(inputDir, BIND_FILE_NAME);
  const pollMs = options.pollMs ?? DEFAULT_BIND_POLL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_BIND_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  fs.mkdirSync(inputDir, { recursive: true });
  while (Date.now() < deadline) {
    if (fs.existsSync(bindPath)) {
      const raw = fs.readFileSync(bindPath, 'utf-8');
      try {
        fs.unlinkSync(bindPath);
      } catch {
        /* ignore */
      }
      const scope = parseBindScope(raw);
      if (scope) {
        log(`Warm bind received via IPC dir (chatJid=${scope.chatJid})`);
        return scope;
      }
      throw new Error('Warm bind file present but not a valid bind scope');
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting ${timeoutMs}ms for warm bind`);
}

/** True when the runner was spawned to boot generic (warm-pool worker). */
export function isWarmGenericBoot(agentInput: {
  warmGenericBoot?: boolean;
}): boolean {
  if (agentInput.warmGenericBoot === true) return true;
  return process.env.GANTRY_WARM_POOL_BOOT === 'generic';
}
