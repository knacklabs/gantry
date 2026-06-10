import { describe, expect, it } from 'vitest';
import { makeFakePool } from './helpers/fakes.js';
import {
  loadTranscript,
  transcriptSql,
} from '../src/reconciler/gantry-source.js';

describe('transcriptSql / loadTranscript', () => {
  it('selects the NEWEST window, re-sorted oldest→newest', () => {
    const sql = transcriptSql('gantry');
    // Inner query takes the newest rows…
    expect(sql).toContain('ORDER BY m.created_at DESC, m.id DESC, p.ordinal DESC');
    expect(sql).toContain('LIMIT $2');
    // …outer query restores reading order for the prompt.
    expect(sql).toContain('ORDER BY t.created_at ASC, t.id ASC, t.ordinal ASC');
  });

  it('returns role-tagged turns with command lines and their acks stripped', async () => {
    const { pool, query } = makeFakePool(() => ({
      rows: [
        { direction: 'inbound', text: '/extract-leads-queries' },
        { direction: 'outbound', text: 'Running lead/query extraction…' },
        { direction: 'inbound', text: 'I want 2 boxes' },
        { direction: 'outbound', text: 'Sure! Kaju Katli?' },
      ],
    }));
    const turns = await loadTranscript(pool, 'gantry', 'conversation:wa:9001');
    expect(turns).toEqual([
      { role: 'customer', text: 'I want 2 boxes' },
      { role: 'assistant', text: 'Sure! Kaju Katli?' },
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('LIMIT $2'), [
      'conversation:wa:9001',
      80,
    ]);
  });
});
