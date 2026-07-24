import { getProviderIds, parseRuntimeProvider } from './provider-utils.js';
import type { RuntimeProviderId } from './provider-utils.js';
import type { ChatAllowlistEntry } from '../config/settings/sender-allowlist.js';

export interface GroupAddOptions {
  selector?: string;
  name?: string;
  folder?: string;
  trigger?: string;
  requiresTrigger?: boolean;
  sendTestMessage: boolean;
}

export interface GroupRemoveOptions {
  selector?: string;
  assumeYes: boolean;
}

export interface GroupTriggerOptions {
  selector?: string;
  trigger?: string;
  disable: boolean;
}

export interface GroupPolicyOptions {
  selector?: string;
  allow?: '*' | string[];
  mode?: ChatAllowlistEntry['mode'];
  clear: boolean;
}

export interface GroupPolicyDefaultOptions {
  channel?: RuntimeProviderId;
  allow?: '*' | string[];
  mode?: ChatAllowlistEntry['mode'];
}

export interface GroupPolicyShowOptions {
  channel?: RuntimeProviderId;
}

function parseBooleanFlag(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') {
    return true;
  }
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') {
    return false;
  }
  return null;
}

function parseAllowArg(raw: string): '*' | string[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  if (trimmed === '[]') return [];
  const values = trimmed
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) return null;
  return values;
}

function parseModeArg(raw: string): ChatAllowlistEntry['mode'] | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'trigger' || trimmed === 'drop') return trimmed;
  return null;
}

export function parseGroupAddArgs(
  args: string[],
): GroupAddOptions | { error: string } {
  const options: GroupAddOptions = {
    sendTestMessage: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--name') {
      options.name = args[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--name=')) {
      options.name = arg.slice('--name='.length);
      continue;
    }

    if (arg === '--folder') {
      options.folder = args[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--folder=')) {
      options.folder = arg.slice('--folder='.length);
      continue;
    }

    if (arg === '--trigger') {
      options.trigger = args[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--trigger=')) {
      options.trigger = arg.slice('--trigger='.length);
      continue;
    }

    if (arg === '--requires-trigger') {
      const rawValue = args[i + 1] || '';
      const parsed = parseBooleanFlag(rawValue);
      if (parsed === null) {
        return {
          error:
            'Invalid value for --requires-trigger. Use true/false (or yes/no, on/off).',
        };
      }
      options.requiresTrigger = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith('--requires-trigger=')) {
      const parsed = parseBooleanFlag(arg.slice('--requires-trigger='.length));
      if (parsed === null) {
        return {
          error:
            'Invalid value for --requires-trigger. Use true/false (or yes/no, on/off).',
        };
      }
      options.requiresTrigger = parsed;
      continue;
    }

    if (arg === '--test-message') {
      options.sendTestMessage = true;
      continue;
    }
    if (arg === '--no-test-message') {
      options.sendTestMessage = false;
      continue;
    }

    if (arg.startsWith('--')) {
      return { error: `Unknown option for agent add: ${arg}` };
    }

    if (!options.selector) {
      options.selector = arg;
      continue;
    }

    return { error: `Unexpected argument for agent add: ${arg}` };
  }

  if (!options.selector) {
    return {
      error: 'Missing JID/chat-id. Usage: gantry agent add <jid|chat-id> ...',
    };
  }

  return options;
}

export function parseGroupRemoveArgs(
  args: string[],
): GroupRemoveOptions | { error: string } {
  const options: GroupRemoveOptions = {
    assumeYes: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--yes' || arg === '-y') {
      options.assumeYes = true;
      continue;
    }
    if (arg.startsWith('--')) {
      return { error: `Unknown option for agent remove: ${arg}` };
    }

    if (!options.selector) {
      options.selector = arg;
      continue;
    }
    return { error: `Unexpected argument for agent remove: ${arg}` };
  }

  if (!options.selector) {
    return {
      error: 'Missing agent selector. Usage: gantry agent remove <jid|folder>',
    };
  }

  return options;
}

export function parseGroupTriggerArgs(
  args: string[],
): GroupTriggerOptions | { error: string } {
  const options: GroupTriggerOptions = {
    disable: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--off') {
      options.disable = true;
      continue;
    }

    if (arg.startsWith('--')) {
      return { error: `Unknown option for agent trigger: ${arg}` };
    }

    if (!options.selector) {
      options.selector = arg;
      continue;
    }

    if (!options.trigger) {
      options.trigger = arg;
      continue;
    }

    return { error: `Unexpected argument for agent trigger: ${arg}` };
  }

  if (!options.selector) {
    return {
      error:
        'Missing agent selector. Usage: gantry agent trigger <jid|folder> <word>|--off',
    };
  }
  if (!options.disable && !options.trigger) {
    return {
      error:
        'Missing trigger word. Usage: gantry agent trigger <jid|folder> <word>',
    };
  }

  return options;
}

export function parseGroupPolicyArgs(
  args: string[],
): GroupPolicyOptions | { error: string } {
  const options: GroupPolicyOptions = {
    clear: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--clear') {
      options.clear = true;
      continue;
    }
    if (arg === '--allow') {
      const raw = args[i + 1] || '';
      const parsed = parseAllowArg(raw);
      if (parsed === null) {
        return {
          error:
            'Invalid value for --allow. Use "*" or a comma-separated sender list.',
        };
      }
      options.allow = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith('--allow=')) {
      const parsed = parseAllowArg(arg.slice('--allow='.length));
      if (parsed === null) {
        return {
          error:
            'Invalid value for --allow. Use "*" or a comma-separated sender list.',
        };
      }
      options.allow = parsed;
      continue;
    }
    if (arg === '--mode') {
      const raw = args[i + 1] || '';
      const parsed = parseModeArg(raw);
      if (!parsed) {
        return {
          error: 'Invalid value for --mode. Use trigger or drop.',
        };
      }
      options.mode = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      const parsed = parseModeArg(arg.slice('--mode='.length));
      if (!parsed) {
        return {
          error: 'Invalid value for --mode. Use trigger or drop.',
        };
      }
      options.mode = parsed;
      continue;
    }
    if (arg.startsWith('--')) {
      return { error: `Unknown option for agent policy: ${arg}` };
    }
    if (!options.selector) {
      options.selector = arg;
      continue;
    }
    return { error: `Unexpected argument for agent policy: ${arg}` };
  }

  if (!options.selector) {
    return {
      error:
        'Missing agent selector. Usage: gantry agent policy <jid|folder> --allow <...> [--mode trigger|drop] or --clear',
    };
  }
  if (
    options.clear &&
    (options.allow !== undefined || options.mode !== undefined)
  ) {
    return {
      error: 'Cannot combine --clear with --allow or --mode.',
    };
  }
  if (!options.clear && options.allow === undefined) {
    return {
      error: 'Missing --allow. Use "*" or a comma-separated sender list.',
    };
  }
  return options;
}

export function parseGroupPolicyDefaultArgs(
  args: string[],
): GroupPolicyDefaultOptions | { error: string } {
  const options: GroupPolicyDefaultOptions = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--channel') {
      const raw = args[i + 1] || '';
      const channel = parseRuntimeProvider(raw);
      if (!channel) {
        return {
          error: `Invalid --channel. Use one of: ${getProviderIds().join(', ')}.`,
        };
      }
      options.channel = channel;
      i += 1;
      continue;
    }
    if (arg.startsWith('--channel=')) {
      const channel = parseRuntimeProvider(arg.slice('--channel='.length));
      if (!channel) {
        return {
          error: `Invalid --channel. Use one of: ${getProviderIds().join(', ')}.`,
        };
      }
      options.channel = channel;
      continue;
    }
    if (arg === '--allow') {
      const parsed = parseAllowArg(args[i + 1] || '');
      if (parsed === null) {
        return {
          error:
            'Invalid value for --allow. Use "*" or a comma-separated sender list.',
        };
      }
      options.allow = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith('--allow=')) {
      const parsed = parseAllowArg(arg.slice('--allow='.length));
      if (parsed === null) {
        return {
          error:
            'Invalid value for --allow. Use "*" or a comma-separated sender list.',
        };
      }
      options.allow = parsed;
      continue;
    }
    if (arg === '--mode') {
      const parsed = parseModeArg(args[i + 1] || '');
      if (!parsed) {
        return {
          error: 'Invalid value for --mode. Use trigger or drop.',
        };
      }
      options.mode = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      const parsed = parseModeArg(arg.slice('--mode='.length));
      if (!parsed) {
        return {
          error: 'Invalid value for --mode. Use trigger or drop.',
        };
      }
      options.mode = parsed;
      continue;
    }
    if (arg.startsWith('--')) {
      return { error: `Unknown option for agent policy-default: ${arg}` };
    }
    return { error: `Unexpected argument for agent policy-default: ${arg}` };
  }

  if (!options.channel) {
    return {
      error: `Missing --channel. Use one of: ${getProviderIds().join(', ')}.`,
    };
  }
  if (options.allow === undefined) {
    return {
      error: 'Missing --allow. Use "*" or a comma-separated sender list.',
    };
  }

  return options;
}

export function parseGroupPolicyShowArgs(
  args: string[],
): GroupPolicyShowOptions | { error: string } {
  const options: GroupPolicyShowOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--channel') {
      const channel = parseRuntimeProvider(args[i + 1] || '');
      if (!channel) {
        return {
          error: `Invalid --channel. Use one of: ${getProviderIds().join(', ')}.`,
        };
      }
      options.channel = channel;
      i += 1;
      continue;
    }
    if (arg.startsWith('--channel=')) {
      const channel = parseRuntimeProvider(arg.slice('--channel='.length));
      if (!channel) {
        return {
          error: `Invalid --channel. Use one of: ${getProviderIds().join(', ')}.`,
        };
      }
      options.channel = channel;
      continue;
    }
    if (arg.startsWith('--')) {
      return { error: `Unknown option for agent policy-show: ${arg}` };
    }
    return { error: `Unexpected argument for agent policy-show: ${arg}` };
  }
  return options;
}
