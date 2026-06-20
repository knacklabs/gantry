export type PromptSurface = 'full' | 'customer_live';

export const PROMPT_SURFACES: readonly PromptSurface[] = [
  'full',
  'customer_live',
];

export function parsePromptSurface(
  value: unknown,
  path: string,
): PromptSurface | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${path} must be one of: ${PROMPT_SURFACES.join(', ')}`);
  }
  const normalized = value.trim();
  if (PROMPT_SURFACES.includes(normalized as PromptSurface)) {
    return normalized as PromptSurface;
  }
  throw new Error(`${path} must be one of: ${PROMPT_SURFACES.join(', ')}`);
}
