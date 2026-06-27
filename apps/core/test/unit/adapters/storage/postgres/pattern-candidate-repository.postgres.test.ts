import { describe, expect, it, vi } from 'vitest';

import { PostgresPatternCandidateRepository } from '@core/adapters/storage/postgres/repositories/pattern-candidate-repository.postgres.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import {
  PATTERN_VALUE_FLOOR_MIN_OCCURRENCES,
  PATTERN_VALUE_FLOOR_MIN_SPAN_DAYS,
} from '@core/shared/pattern-candidate-policy.js';

function flattenSqlShape(value: unknown, seen = new Set<object>()): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (typeof value !== 'object') return '';
  if (seen.has(value)) return '';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => flattenSqlShape(entry, seen)).join(' ');
  }
  const record = value as Record<string | symbol, unknown>;
  return [
    flattenSqlShape(record.value, seen),
    typeof record.name === 'string' ? record.name : '',
    flattenSqlShape(record.queryChunks, seen),
    flattenSqlShape(record.config, seen),
  ].join(' ');
}

describe('PostgresPatternCandidateRepository', () => {
  it('keeps recurrence value floor in the eligibility query', async () => {
    const limit = vi.fn(async () => []);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const db = {
      select: vi.fn(() => ({ from })),
    };
    const repository = new PostgresPatternCandidateRepository(db as never);

    await repository.listEligible({
      subject: {
        appId: 'app:test',
        agentId: 'agent:test',
        subjectType: 'user',
        subjectId: 'user:test',
      },
      limit: 10,
    });

    expect(from).toHaveBeenCalledWith(pgSchema.patternCandidatesPostgres);
    const predicate = where.mock.calls[0]?.[0];
    const sqlShape = flattenSqlShape(predicate);
    expect(sqlShape).toContain('occurrences');
    expect(sqlShape).toContain('window_end');
    expect(sqlShape).toContain('window_start');
    expect(sqlShape).toContain('make_interval');
    expect(sqlShape).toContain(String(PATTERN_VALUE_FLOOR_MIN_OCCURRENCES));
    expect(sqlShape).toContain(String(PATTERN_VALUE_FLOOR_MIN_SPAN_DAYS));
  });
});
