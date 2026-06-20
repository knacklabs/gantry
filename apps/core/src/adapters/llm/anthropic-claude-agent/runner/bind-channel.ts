/**
 * Warm-pool bind receiver (Pillar 2, F3).
 *
 * A warm worker boots GENERIC (no customer identity / first message), signals
 * ready, then awaits a BIND that carries the per-customer scope over a
 * NON-stdin channel. Stdin is read once and closed at spawn
 * (`agent-spawn-process.ts`), so the bind cannot ride stdin.
 *
 * Bind delivery is socket-only. A missing bind push is a runtime error.
 */
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
  runHandle?: string;
  threadId?: string;
  memoryUserId?: string;
  ipcAuthToken?: string;
  browserIpcAuthToken?: string;
  memoryIpcAuthToken?: string;
  ipcResponseKeyId?: string;
  ipcResponseVerifyKey?: string;
}

export interface AwaitBindOptions {
  /** Max wait for the bind before giving up (ms). Undefined means wait forever. */
  timeoutMs?: number;
}

let pendingSocketBind: ConversationBindScope | undefined;
const socketBindWaiters: Array<(scope: ConversationBindScope) => void> = [];

function parseBindScopeValue(
  value: unknown,
): ConversationBindScope | undefined {
  try {
    const parsed = value as Partial<ConversationBindScope> & {
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
      runHandle:
        typeof scope.runHandle === 'string' ? scope.runHandle : undefined,
      threadId: typeof scope.threadId === 'string' ? scope.threadId : undefined,
      memoryUserId:
        typeof scope.memoryUserId === 'string' ? scope.memoryUserId : undefined,
      ipcAuthToken:
        typeof scope.ipcAuthToken === 'string' ? scope.ipcAuthToken : undefined,
      browserIpcAuthToken:
        typeof scope.browserIpcAuthToken === 'string'
          ? scope.browserIpcAuthToken
          : undefined,
      memoryIpcAuthToken:
        typeof scope.memoryIpcAuthToken === 'string'
          ? scope.memoryIpcAuthToken
          : undefined,
      ipcResponseKeyId:
        typeof scope.ipcResponseKeyId === 'string'
          ? scope.ipcResponseKeyId
          : undefined,
      ipcResponseVerifyKey:
        typeof scope.ipcResponseVerifyKey === 'string'
          ? scope.ipcResponseVerifyKey
          : undefined,
    };
  } catch {
    return undefined;
  }
}

export function acceptSocketBindPayload(payload: unknown): boolean {
  const scope = parseBindScopeValue(payload);
  if (!scope) return false;
  const waiter = socketBindWaiters.shift();
  if (waiter) {
    waiter(scope);
    return true;
  }
  pendingSocketBind = scope;
  return true;
}

function takePendingSocketBind(): ConversationBindScope | undefined {
  const scope = pendingSocketBind;
  pendingSocketBind = undefined;
  return scope;
}

/**
 * Await the per-customer bind. Resolves with the scope once it arrives.
 * Socket bind pushes are captured by acceptSocketBindPayload().
 */
export async function awaitBind(
  options: AwaitBindOptions = {},
): Promise<ConversationBindScope> {
  const socketScope = takePendingSocketBind();
  if (socketScope) {
    log(`Warm bind received via IPC socket (chatJid=${socketScope.chatJid})`);
    return socketScope;
  }
  const timeoutMs = options.timeoutMs;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiter = (scope: ConversationBindScope) => {
      if (timer) clearTimeout(timer);
      log(`Warm bind received via IPC socket (chatJid=${scope.chatJid})`);
      resolve(scope);
    };
    socketBindWaiters.push(waiter);
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        const index = socketBindWaiters.indexOf(waiter);
        if (index >= 0) socketBindWaiters.splice(index, 1);
        reject(new Error(`Timed out waiting ${timeoutMs}ms for warm bind`));
      }, timeoutMs);
    }
  });
}

/** True when the runner was spawned to boot generic (warm-pool worker). */
export function isWarmGenericBoot(agentInput: {
  warmGenericBoot?: boolean;
}): boolean {
  if (agentInput.warmGenericBoot === true) return true;
  return process.env.GANTRY_WARM_POOL_BOOT === 'generic';
}
