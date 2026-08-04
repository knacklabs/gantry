import type { ObserverSubjectKey } from '../domain/ports/observer-insights.js';
import { canonicalizeObserverInsightText } from '../shared/observer-insight-policy.js';

export interface ObserverActiveMemoryReadPort {
  listActiveValues(input: {
    appId: string;
    subject: ObserverSubjectKey;
  }): Promise<readonly string[]>;
}

export async function loadCanonicalActiveMemoryValues(input: {
  memory: ObserverActiveMemoryReadPort;
  appId: string;
  subject: ObserverSubjectKey;
}): Promise<ReadonlySet<string>> {
  const rows = await input.memory.listActiveValues(input);
  const values = new Set<string>();
  for (const row of rows) {
    const value = canonicalizeObserverInsightText(row);
    if (value) values.add(value);
  }
  return values;
}

export async function hasExactActiveMemoryMatch(input: {
  memory: ObserverActiveMemoryReadPort;
  appId: string;
  subject: ObserverSubjectKey;
  candidateText: string;
}): Promise<boolean> {
  const candidate = canonicalizeObserverInsightText(input.candidateText);
  if (!candidate) return false;
  const values = await loadCanonicalActiveMemoryValues(input);
  return values.has(candidate);
}
