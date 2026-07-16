import type { ThinkingEffort, ThinkingOverride } from '../domain/types.js';
import type { PermissionMode } from '../shared/permission-mode.js';

// Host-managed slash-command parsing and authorization. Split out of
// session-commands.ts (which owns command EXECUTION) so the pure text->command
// decode and the auth predicate live in one small module.

export type SessionCommand =
  | { kind: 'commands'; raw: '/commands' }
  | { kind: 'compact'; raw: '/compact' }
  | { kind: 'new'; raw: '/new' }
  | { kind: 'stop'; raw: '/stop' }
  | { kind: 'dream'; raw: '/dream' }
  | { kind: 'memory_status'; raw: '/memory-status' }
  | { kind: 'models_list'; raw: '/models' }
  | { kind: 'status'; raw: '/status' }
  | { kind: 'save_procedure'; raw: string; title: string; body?: string }
  | { kind: 'model_show'; raw: '/model' }
  | { kind: 'model_why'; raw: string; value: string }
  | { kind: 'model_set'; raw: string; value: string }
  | { kind: 'model_default'; raw: '/model default' }
  | { kind: 'thinking_show'; raw: '/thinking' }
  | { kind: 'thinking_set'; raw: string; value: ThinkingOverride }
  | { kind: 'thinking_default'; raw: '/thinking default' }
  | { kind: 'permissions_show'; raw: '/permissions' }
  | { kind: 'permissions_set'; raw: string; value: PermissionMode }
  | { kind: 'permissions_default'; raw: '/permissions default' };

function parsePermissionsCommand(text: string): SessionCommand | null {
  if (text === '/permissions')
    return { kind: 'permissions_show', raw: '/permissions' };
  const value = text.match(/^\/permissions\s+(ask|auto|default)$/)?.[1];
  if (value === 'default')
    return { kind: 'permissions_default', raw: '/permissions default' };
  return value === 'ask' || value === 'auto'
    ? { kind: 'permissions_set', raw: `/permissions ${value}`, value }
    : null;
}

function parseThinkingCommand(text: string): SessionCommand | null {
  if (text === '/thinking') return { kind: 'thinking_show', raw: '/thinking' };

  const thinkingMatch = text.match(/^\/thinking\s+(.+)$/);
  if (!thinkingMatch) return null;

  const value = thinkingMatch[1].trim();
  if (value === 'default') {
    return { kind: 'thinking_default', raw: '/thinking default' };
  }
  if (value === 'off' || value === 'disabled') {
    return {
      kind: 'thinking_set',
      raw: `/thinking ${value}`,
      value: { mode: 'disabled' },
    };
  }
  if (value === 'adaptive') {
    return {
      kind: 'thinking_set',
      raw: '/thinking adaptive',
      value: { mode: 'adaptive' },
    };
  }
  if (value === 'enabled') {
    return {
      kind: 'thinking_set',
      raw: '/thinking enabled',
      value: { mode: 'enabled' },
    };
  }
  const effortMatch = value.match(/^(low|medium|high|max)$/);
  if (effortMatch) {
    return {
      kind: 'thinking_set',
      raw: `/thinking ${effortMatch[1]}`,
      value: { mode: 'adaptive', effort: effortMatch[1] as ThinkingEffort },
    };
  }
  const enabledBudgetMatch = value.match(/^enabled\s+(\d+)$/);
  if (enabledBudgetMatch) {
    const budgetTokens = Number(enabledBudgetMatch[1]);
    if (!Number.isSafeInteger(budgetTokens) || budgetTokens <= 0) return null;
    return {
      kind: 'thinking_set',
      raw: `/thinking enabled ${budgetTokens}`,
      value: { mode: 'enabled', budgetTokens },
    };
  }

  return null;
}

function parseMentionFriendlySessionCommand(
  text: string,
): SessionCommand | null {
  if (!text.startsWith('!')) return null;

  const commandText = text.slice(1).trim();
  if (commandText === 'commands' || commandText === 'help') {
    return { kind: 'commands', raw: '/commands' };
  }
  if (commandText === 'compact') {
    return { kind: 'compact', raw: '/compact' };
  }
  if (commandText === 'new') {
    return { kind: 'new', raw: '/new' };
  }
  if (commandText === 'stop') {
    return { kind: 'stop', raw: '/stop' };
  }
  if (commandText === 'dream') return { kind: 'dream', raw: '/dream' };
  if (commandText === 'memory-status') {
    return { kind: 'memory_status', raw: '/memory-status' };
  }
  if (commandText === 'models') return { kind: 'models_list', raw: '/models' };
  if (commandText === 'status') return { kind: 'status', raw: '/status' };
  if (commandText === 'model') return { kind: 'model_show', raw: '/model' };

  const modelMatch = commandText.match(/^model\s+(.+)$/);
  if (modelMatch) {
    const value = modelMatch[1].trim();
    if (value === 'default') {
      return { kind: 'model_default', raw: '/model default' };
    }
    const whyMatch = value.match(/^why\s+(.+)$/);
    if (whyMatch) {
      const whyValue = whyMatch[1].trim();
      return {
        kind: 'model_why',
        raw: `/model why ${whyValue}`,
        value: whyValue,
      };
    }
    return {
      kind: 'model_set',
      raw: `/model ${value}`,
      value,
    };
  }

  const thinkingMatch = commandText.match(/^thinking(?:\s+(.+))?$/);
  if (thinkingMatch) {
    return parseThinkingCommand(
      thinkingMatch[1] ? `/thinking ${thinkingMatch[1].trim()}` : '/thinking',
    );
  }

  const permissionsMatch = commandText.match(/^permissions(?:\s+(.+))?$/);
  if (permissionsMatch) {
    return parsePermissionsCommand(
      permissionsMatch[1]
        ? `/permissions ${permissionsMatch[1].trim()}`
        : '/permissions',
    );
  }

  return null;
}

function normalizeGantryCommandEnvelope(text: string): string {
  const match = text.match(/^\/gantry(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/);
  if (!match) return text;
  const command = match[1]?.trim();
  if (!command || command === 'help' || command === 'commands') {
    return '/commands';
  }
  return command.startsWith('/') ? command : `/${command}`;
}

export function extractSessionCommand(
  content: string,
  triggerPattern: RegExp,
): SessionCommand | null {
  let text = content.trim();
  const hasTriggerPrefix = new RegExp(
    triggerPattern.source,
    triggerPattern.flags.replace(/g/g, ''),
  ).test(text);
  text = text.replace(triggerPattern, '').trim();
  text = normalizeGantryCommandEnvelope(text);
  if (text === '/commands') return { kind: 'commands', raw: '/commands' };
  if (text === '/compact') return { kind: 'compact', raw: '/compact' };
  if (text === '/new') return { kind: 'new', raw: '/new' };
  if (text === '/stop') return { kind: 'stop', raw: '/stop' };
  if (text === '/dream') return { kind: 'dream', raw: '/dream' };
  if (text === '/memory-status')
    return { kind: 'memory_status', raw: '/memory-status' };
  if (text === '/models') return { kind: 'models_list', raw: '/models' };
  if (text === '/status') return { kind: 'status', raw: '/status' };
  if (text === '/model') return { kind: 'model_show', raw: '/model' };
  const saveProcedureMatch = text.match(
    /^\/save-procedure(?:\s+"([^"\n]{1,80})"|\s+([^\n]{1,80}))(?:\n([\s\S]+))?$/,
  );
  if (saveProcedureMatch) {
    const title = (saveProcedureMatch[1] || saveProcedureMatch[2] || '').trim();
    const body = saveProcedureMatch[3]?.trim();
    if (title) {
      return {
        kind: 'save_procedure',
        raw: text,
        title,
        ...(body ? { body } : {}),
      };
    }
  }

  const modelMatch = text.match(/^\/model\s+(.+)$/);
  if (modelMatch) {
    const value = modelMatch[1].trim();
    if (value === 'default') {
      return { kind: 'model_default', raw: '/model default' };
    }
    const whyMatch = value.match(/^why\s+(.+)$/);
    if (whyMatch) {
      const whyValue = whyMatch[1].trim();
      return {
        kind: 'model_why',
        raw: `/model why ${whyValue}`,
        value: whyValue,
      };
    }
    return {
      kind: 'model_set',
      raw: `/model ${value}`,
      value,
    };
  }

  const thinking = parseThinkingCommand(text);
  if (thinking) return thinking;
  const permissions = parsePermissionsCommand(text);
  if (permissions) return permissions;

  if (hasTriggerPrefix) {
    const mentionFriendly = parseMentionFriendlySessionCommand(text);
    if (mentionFriendly) return mentionFriendly;
  }

  return null;
}

/**
 * Check if a session command sender is authorized.
 * Allowed only for trusted/admin sender (is_from_me) or explicit sender allowlist membership.
 */
export function isSessionCommandAllowed(
  isFromMe: boolean,
  isSenderControlAllowlisted: boolean,
): boolean {
  return isFromMe || isSenderControlAllowlisted;
}

export interface AgentResult {
  status: 'success' | 'error';
  result?: string | object | null;
}
