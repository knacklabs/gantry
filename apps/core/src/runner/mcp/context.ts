import path from 'path';

function requirePathEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const IPC_DIR = requirePathEnv('MYCLAW_IPC_DIR');
export const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
export const TASKS_DIR = path.join(IPC_DIR, 'tasks');
export const MEMORY_REQUESTS_DIR = path.join(IPC_DIR, 'memory-requests');
export const MEMORY_RESPONSES_DIR = path.join(IPC_DIR, 'memory-responses');
export const BROWSER_REQUESTS_DIR = path.join(IPC_DIR, 'browser-requests');
export const BROWSER_RESPONSES_DIR = path.join(IPC_DIR, 'browser-responses');
export const TASK_RESPONSES_DIR = path.join(IPC_DIR, 'task-responses');
export const IPC_AUTH_TOKEN = process.env.MYCLAW_IPC_AUTH_TOKEN || '';
export const BROWSER_IPC_AUTH_TOKEN =
  process.env.MYCLAW_BROWSER_IPC_AUTH_TOKEN || IPC_AUTH_TOKEN;
export const MEMORY_IPC_AUTH_TOKEN =
  process.env.MYCLAW_MEMORY_IPC_AUTH_TOKEN || IPC_AUTH_TOKEN;
export const IPC_RESPONSE_VERIFY_KEY =
  process.env.MYCLAW_IPC_RESPONSE_VERIFY_KEY || '';

export const chatJid = process.env.MYCLAW_CHAT_JID!;
export const groupFolder = process.env.MYCLAW_GROUP_FOLDER!;
export const threadId = process.env.MYCLAW_THREAD_ID?.trim() || undefined;
export const memoryUserId =
  process.env.MYCLAW_MEMORY_USER_ID?.trim() || undefined;
export const memoryDefaultScope =
  process.env.MYCLAW_MEMORY_DEFAULT_SCOPE === 'user' ? 'user' : 'group';
export const browserProfileName =
  process.env.MYCLAW_BROWSER_PROFILE_NAME?.trim() || undefined;
export const isMain = process.env.MYCLAW_IS_MAIN === '1';
