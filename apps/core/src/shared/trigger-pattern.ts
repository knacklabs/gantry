const DEFAULT_ASSISTANT_NAME = 'Gantry';

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function defaultTriggerForAgentName(name?: string | null): string {
  return `@${name?.trim() || DEFAULT_ASSISTANT_NAME}`;
}

export function triggerForRoute(input: {
  trigger?: string | null;
  name?: string | null;
}): string {
  return input.trigger?.trim() || defaultTriggerForAgentName(input.name);
}

export function buildTriggerPattern(trigger: string): RegExp {
  const normalizedTrigger = trigger.trim();
  const pattern = escapeRegex(normalizedTrigger);
  return new RegExp(
    `(?:^|\\s)${pattern}(?:\\b|(?=\\s|[,.!?;:，。！？、；：]|$))`,
    'i',
  );
}
