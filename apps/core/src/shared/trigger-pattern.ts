import { DEFAULT_AGENT_NAME } from './default-agent.js';

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function defaultTriggerForAgentName(name?: string | null): string {
  return `@${name?.trim() || DEFAULT_AGENT_NAME}`;
}

export function triggerForRoute(input: {
  trigger?: string | null;
  name?: string | null;
}): string {
  return input.trigger?.trim() || defaultTriggerForAgentName(input.name);
}

export function buildTriggerPattern(trigger: string): RegExp {
  const normalizedTrigger = trigger.trim();
  const slackMentionMatch = normalizedTrigger.match(/^<@([A-Z0-9]+)>?$/i);
  if (slackMentionMatch) {
    const mention = `<@${escapeRegex(slackMentionMatch[1])}>?`;
    return new RegExp(`(?:^|\\s)${mention}(?=\\s|$|[,.!?;:])`, 'i');
  }
  return new RegExp(`^${escapeRegex(normalizedTrigger)}\\b`, 'i');
}
