import type { ClaudeQueryOpts } from './claude-query.js';

export type ModelQueryOpts = ClaudeQueryOpts;

export async function runModelQuery(opts: ModelQueryOpts): Promise<string> {
  const { runClaudeQuery } = await import('./claude-query.js');
  return runClaudeQuery(opts);
}
